import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
// Type-only import — erased at compile time, so it never pulls the llama.rn
// native module into the bundle or the Expo Go runtime (the actual module is
// loaded lazily via dynamic import below).
import type { CompletionResponseFormat, LlamaContext } from 'llama.rn';

import { FOOD_CLAIM_SCHEMA } from './schema';

/**
 * On-device model manager for the fine-tuned MacroTrack estimator
 * (Qwen3.5-0.8B text QLoRA → GGUF Q4_K_M, run via llama.rn). Owns the model
 * files (download / presence / delete) and the llama.rn context lifecycle.
 *
 * llama.rn is a native module that only exists in an Expo **dev build** — it
 * is absent in Expo Go and on web. This file is the native implementation;
 * `local-model.web.ts` is the web stub Metro resolves instead, so llama.rn
 * never enters the web bundle. See docs/integration-notes.md.
 */

// ---- Model artifacts (hosted on a public GitHub release) ----
// The GGUF lives on the `text-v1` release. sizeBytes is byte-exact and checked
// after download as a cheap integrity guard (sha256 5777ca4e…ede0, in
// models/README.md).

/** Release tag of the bundled fine-tune — recorded on every saved estimator
 *  interaction so exported ai_events say which model made each claim. */
export const LOCAL_MODEL_RELEASE_TAG = 'text-v1';

const MODEL_BASE_URL = `https://github.com/jonathansteffens/macrotrack/releases/download/${LOCAL_MODEL_RELEASE_TAG}`;

type ModelFile = { name: string; sizeBytes: number };

const TEXT_MODEL: ModelFile = {
  name: 'macrotrack-text-0.8b-q4_k_m.gguf',
  sizeBytes: 529_296_640,
};
// Text-only: there is no vision projector. The model estimates from a text
// description of the meal. To restore photo estimates you'd swap in a
// vision-capable GGUF + mmproj and re-enable ctx.initMultimodal() below.
const MODEL_FILES = [TEXT_MODEL];

export const LOCAL_MODEL_TOTAL_BYTES = MODEL_FILES.reduce((s, f) => s + f.sizeBytes, 0);

export type LocalModelStatus = 'ready' | 'missing' | 'unsupported';

export class LocalModelUnavailable extends Error {
  constructor(readonly reason: 'unsupported' | 'missing') {
    super(reason === 'unsupported' ? 'On-device model not supported here' : 'Model not downloaded');
  }
}

// ---- File locations ----

function modelsDir(): Directory {
  return new Directory(Paths.document, 'models');
}
function fileFor(f: ModelFile): File {
  return new File(modelsDir(), f.name);
}
/** A file counts as present only if it exists AND is the expected size. */
function isComplete(f: ModelFile): boolean {
  const file = fileFor(f);
  return file.exists && file.size === f.sizeBytes;
}

// ---- Status / download / delete ----

export function isLocalModelSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

export async function getLocalModelStatus(): Promise<LocalModelStatus> {
  if (!isLocalModelSupported()) return 'unsupported';
  return MODEL_FILES.every(isComplete) ? 'ready' : 'missing';
}

/**
 * Download any missing model files, reporting overall fraction complete
 * (0–1). Idempotent — already-complete files are skipped, so it doubles as a
 * resume after an interrupted download.
 */
export async function downloadLocalModel(onProgress?: (fraction: number) => void): Promise<void> {
  if (!isLocalModelSupported()) throw new LocalModelUnavailable('unsupported');
  const dir = modelsDir();
  if (!dir.exists) dir.create({ intermediates: true });

  const doneBytes = MODEL_FILES.filter(isComplete).reduce((s, f) => s + f.sizeBytes, 0);
  let baselineBytes = doneBytes;

  for (const f of MODEL_FILES) {
    if (isComplete(f)) continue;
    const dest = fileFor(f);
    if (dest.exists) dest.delete(); // partial/corrupt — start clean

    const task = File.createDownloadTask(`${MODEL_BASE_URL}/${f.name}`, dest, {
      onProgress: ({ bytesWritten }) => {
        onProgress?.(Math.min(1, (baselineBytes + bytesWritten) / LOCAL_MODEL_TOTAL_BYTES));
      },
    });
    await task.downloadAsync();

    if (!isComplete(f)) {
      dest.delete();
      throw new Error(`Downloaded ${f.name} is the wrong size — check MODEL_BASE_URL and retry.`);
    }
    baselineBytes += f.sizeBytes;
    onProgress?.(Math.min(1, baselineBytes / LOCAL_MODEL_TOTAL_BYTES));
  }
  await releaseLocalContext(); // force a reload against the new files
}

export async function deleteLocalModel(): Promise<void> {
  await releaseLocalContext();
  for (const f of MODEL_FILES) {
    const file = fileFor(f);
    if (file.exists) file.delete();
  }
}

// ---- llama.rn context: lazy singleton + serialized access ----
//
// The context holds the model weights + KV cache (~0.6 GB working set); load it
// on first use and release it when the app backgrounds (releaseLocalContext).
// completion() is not
// re-entrant, so all access is serialized through a promise chain. llama.rn is
// imported dynamically so it's only touched in a dev build with the model
// present — never at module-load time (which would crash in Expo Go).

let contextPromise: Promise<LlamaContext> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function loadContext(): Promise<LlamaContext> {
  if ((await getLocalModelStatus()) !== 'ready') {
    throw new LocalModelUnavailable(isLocalModelSupported() ? 'missing' : 'unsupported');
  }
  const { initLlama } = await import('llama.rn');
  const ctx = await initLlama({
    model: fileFor(TEXT_MODEL).uri,
    n_ctx: 4096, // system prompt (~600) + meal description + claim fit comfortably
    n_gpu_layers: 99, // Metal (iOS) / GPU-delegate (Android); falls back to CPU
    // Pin to the performance cores. Most modern Android SoCs have ~4 big cores
    // (Tensor G2: 2×X1 + 2×A78); spilling onto the little A55 cores usually
    // slows decode, since threads sync to the slowest. Tune per device.
    n_threads: 4,
    flash_attn: true, // less attention memory traffic → faster decode
    use_mlock: false, // let the OS page under memory pressure
  });
  return ctx;
}

/** Run `fn` against the loaded context, serialized against other callers. */
export function runOnLocalContext<T>(fn: (ctx: LlamaContext) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    if (!contextPromise) {
      contextPromise = loadContext().catch((e) => {
        contextPromise = null; // allow a retry after a failed load
        throw e;
      });
    }
    return fn(await contextPromise);
  });
  // keep the chain alive regardless of this call's outcome
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Fire-and-forget warm-up: kick off the lazy context load so the model is
 * ready by the time the user submits (the assist screen calls this on mount
 * while the user is still typing). Errors — missing model, unsupported
 * platform — are swallowed; the real estimate call surfaces them to the UI.
 */
export function ensureLoaded(): void {
  runOnLocalContext(() => Promise.resolve()).catch(() => {});
}

/** Unload the model — call when the app backgrounds to free memory. */
export async function releaseLocalContext(): Promise<void> {
  const p = contextPromise;
  contextPromise = null;
  if (!p) return;
  try {
    const ctx = await p;
    await ctx.release?.();
  } catch {
    // context never finished loading — nothing to release
  }
}

/**
 * JSON-schema constraint for the FoodClaim output. llama.rn compiles this to a
 * GBNF grammar internally — the same mechanism the eval harness exercises
 * through llama-server, so on-device output matches what was evaluated.
 */
export const CLAIM_RESPONSE_FORMAT: CompletionResponseFormat = {
  type: 'json_schema',
  json_schema: { strict: true, schema: FOOD_CLAIM_SCHEMA },
};
