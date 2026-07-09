// Type-only — erased at compile time, so importing the token-callback shape
// never pulls the llama.rn native module into the bundle (see local-model.ts).
import type { TokenData } from 'llama.rn';

import { ESTIMATOR_SYSTEM_PROMPT } from './prompt';
import { sanitizeClaim, type EstimateResult } from './estimator';
import {
  CLAIM_RESPONSE_FORMAT,
  LocalModelUnavailable,
  runOnLocalContext,
} from './local-model';
import { extractCompleteItems } from './stream-parse';
import type { EstimateTurn, FoodClaim } from './types';

/**
 * A single claim item as it finishes decoding, for the live estimating UI.
 * Name + grams only — this is a lightweight preview; the authoritative numbers
 * come from the full DB resolution that still runs once at the end.
 */
export type StreamItem = { index: number; name: string; grams: number };

/** Lightweight per-item grams for the live preview (no DB): count × unit_grams
 *  when the model gave a whole-unit count, else the model's total grams. */
function previewGrams(raw: Record<string, unknown>): number {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const count = num(raw.count);
  const unit = num(raw.unit_grams);
  const g = count > 0 && unit > 0 ? count * unit : num(raw.grams);
  return Math.round(g);
}

/**
 * On-device estimator: the full task in one call, and the app's ONLY estimator
 * (there is no cloud engine). The fine-tuned Qwen2.5-VL-3B model (see
 * docs/finetune-report.md) reads the system prompt + conversation (text and/or
 * photo) and emits a complete FoodClaim, replacing the earlier 3-stage Haiku
 * stand-in. Output is constrained to the FoodClaim JSON schema via llama.rn's
 * grammar sampling, so it always parses. If the model isn't downloaded (or the
 * platform can't run it), it returns `needsModel` / a plain error — the UI
 * prompts the user to download it.
 */

// Text-only chat (the vision path is disabled for now — see local-model.ts).
type Message = { role: 'system' | 'user' | 'assistant'; content: string };

function buildMessages(turns: EstimateTurn[]): Message[] {
  const messages: Message[] = [{ role: 'system', content: ESTIMATOR_SYSTEM_PROMPT }];
  for (const turn of turns) {
    messages.push(
      turn.role === 'assistant'
        ? { role: 'assistant', content: JSON.stringify(turn.claim) }
        : {
            role: 'user',
            content: turn.input.text?.trim() || 'Estimate the nutrition of this meal.',
          }
    );
  }
  return messages;
}

/**
 * Parse the model's text into a FoodClaim. Grammar-constrained output should
 * be pure JSON, but be defensive: strip markdown code fences and, failing
 * that, extract the outermost {...} object (in case a preamble or trailing
 * chat-template tokens leak in).
 */
function parseClaim(raw: string): FoodClaim {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as FoodClaim;
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as FoodClaim;
    }
    throw new SyntaxError('no JSON object found in model output');
  }
}

export async function localEstimate(
  turns: EstimateTurn[],
  onItem?: (item: StreamItem) => void,
  opts: { temperature?: number } = {}
): Promise<EstimateResult> {
  const firstUser = turns.find((t) => t.role === 'user');
  if (!firstUser) return { ok: false, message: 'Nothing to estimate yet.' };
  // Default 0 (deterministic). A retry passes a small temperature so a
  // deterministic truncation/parse failure doesn't reproduce identically.
  const temperature = opts.temperature ?? 0;

  let raw: string;
  try {
    raw = await runOnLocalContext((ctx) => {
      // Live streaming: llama.rn fires the token callback per decoded token when
      // one is supplied (emit_partial_completion). We accumulate the text and,
      // each time another item object closes in the JSON, hand it to onItem. If
      // the running llama.rn build never invokes the callback the buffer just
      // stays empty and behaviour is unchanged (indicator only) — graceful.
      // Signature verified in node_modules/llama.rn/lib/typescript/index.d.ts:
      //   completion(params: CompletionParams, callback?: (data: TokenData) => void): Promise<NativeCompletionResult>
      let buf = '';
      let emitted = 0;
      const onToken = onItem
        ? (data: TokenData) => {
            // Prefer the native running total when present; otherwise append
            // the incremental token (README single-completion path: `data.token`).
            buf =
              typeof data.accumulated_text === 'string'
                ? data.accumulated_text
                : buf + (data.token ?? '');
            const done = extractCompleteItems(buf);
            while (emitted < done.length) {
              const it = done[emitted];
              onItem({
                index: emitted,
                name: typeof it.name === 'string' ? it.name : '',
                grams: previewGrams(it),
              });
              emitted++;
            }
          }
        : undefined;
      return ctx
        .completion(
          {
            messages: buildMessages(turns),
            jinja: true, // apply the model's embedded chat template (vision tokens)
            n_predict: 1536, // a 6-item claim is ~500 tokens; large multi-item meals can
            //                   exceed 1024 and truncate to unparseable JSON, so give headroom
            temperature,
            response_format: CLAIM_RESPONSE_FORMAT,
          },
          onToken
        )
        .then((r) => r.text);
    });
  } catch (e) {
    if (e instanceof LocalModelUnavailable) {
      return e.reason === 'missing'
        ? {
            ok: false,
            needsModel: true,
            message: 'Download the on-device model in Settings to use AI logging.',
          }
        : { ok: false, message: 'On-device AI isn’t available on this device.' };
    }
    return { ok: false, message: 'On-device estimate failed. Please try again.' };
  }

  try {
    return { ok: true, claim: sanitizeClaim(parseClaim(raw)) };
  } catch {
    // Surface the raw output so we can see WHY it didn't parse (Metro console).
    console.warn('[localEstimate] unparseable model output >>>\n' + raw + '\n<<< end');
    return {
      ok: false,
      message: 'Could not parse the on-device model response. Please try again.',
    };
  }
}
