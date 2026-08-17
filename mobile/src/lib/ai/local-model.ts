import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
// Type-only import — erased at compile time, so it never pulls the llama.rn
// native module into the bundle or the Expo Go runtime (the actual module is
// loaded lazily via dynamic import below).
import type { CompletionResponseFormat, LlamaContext } from 'llama.rn';

import { stalePruneTargets, type StorageEntry } from './model-storage';
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
// The GGUF lives on the `text-v3` release. sizeBytes is byte-exact and checked
// after download as a cheap integrity guard (sha256 eb8a2104…6378, in
// models/README.md).

/** Release tag of the bundled fine-tune — recorded on every saved estimator
 *  interaction so exported ai_events say which model made each claim. */
export const LOCAL_MODEL_RELEASE_TAG = 'text-v3';

const MODEL_BASE_URL = `https://github.com/jonathansteffens/macrotrack/releases/download/${LOCAL_MODEL_RELEASE_TAG}`;

type ModelFile = { name: string; sizeBytes: number };

const TEXT_MODEL: ModelFile = {
  name: 'macrotrack-text-0.8b-q4_k_m.gguf',
  sizeBytes: 529_296_704,
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
//
// Model files are stored PER RELEASE TAG: documents/models/<tag>/<filename>.
//
// They used to sit at documents/models/<filename> with no tag, and presence was
// "the filename exists at the expected byte size". That is a corruption guard,
// not a version check, and it cannot tell two same-size fine-tunes apart — v8
// (text-v2) and v10 (text-v3) share the filename AND the exact size
// (529,296,704 bytes), differing only in sha. On a phone that already had v8,
// bumping the tag therefore left Settings reporting "installed", skipped the
// download entirely, kept running v8 weights, and still stamped the new tag
// into every ai_events row — corrupting the provenance of the training export.
//
// Scoping the path by tag makes a bump read as 'missing', which is what makes
// the download actually run. The size check below is unchanged and still does
// its real job: catching a truncated or corrupt transfer.

/** Container for every tag's directory. */
function modelsRoot(): Directory {
  return new Directory(Paths.document, 'models');
}
/** Directory holding the CURRENT tag's files. */
function modelsDir(): Directory {
  return new Directory(modelsRoot(), LOCAL_MODEL_RELEASE_TAG);
}
function fileFor(f: ModelFile): File {
  return new File(modelsDir(), f.name);
}
/**
 * A file counts as present only if it exists AND is the expected size.
 *
 * Unchanged, deliberately: it is the integrity guard against a partial
 * download. It is no longer also load-bearing for versioning — the tag in the
 * path does that — so a same-size different-weights build can no longer pass
 * for an install.
 */
function isComplete(f: ModelFile): boolean {
  const file = fileFor(f);
  return file.exists && file.size === f.sizeBytes;
}

/**
 * Delete other tags' directories and any legacy untagged file, reclaiming the
 * ~529 MB an old build leaves behind.
 *
 * Only ever called after the current tag is fully downloaded, so a failed or
 * interrupted update never destroys the model the user still has. Best-effort:
 * a failure here costs disk space, not correctness, and must not turn a
 * successful download into a thrown error.
 */
function pruneOtherVersions(): void {
  const root = modelsRoot();
  if (!root.exists) return;
  let entries: StorageEntry[];
  try {
    entries = root.list().map((e) => ({ name: e.name, isDirectory: e instanceof Directory }));
  } catch {
    return;
  }
  for (const name of stalePruneTargets(entries, LOCAL_MODEL_RELEASE_TAG)) {
    try {
      const dir = new Directory(root, name);
      if (dir.exists) {
        dir.delete(); // removes the directory and its contents
        continue;
      }
      const file = new File(root, name);
      if (file.exists) file.delete();
    } catch {
      // leave it; the next successful download tries again
    }
  }
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
  // Only now that the new tag is complete and nothing holds the old weights
  // open: reclaim the space the previous release was using.
  pruneOtherVersions();
}

export async function deleteLocalModel(): Promise<void> {
  // Release first: the context holds the weights open.
  await releaseLocalContext();
  // Remove every tag, not just the current one — "delete the model" should
  // reclaim all of it, including anything an earlier release left behind.
  const root = modelsRoot();
  if (root.exists) root.delete();
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
