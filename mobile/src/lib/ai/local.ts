import { ESTIMATOR_SYSTEM_PROMPT } from './prompt';
import { sanitizeClaim, type EstimateResult } from './estimator';
import {
  CLAIM_RESPONSE_FORMAT,
  LocalModelUnavailable,
  runOnLocalContext,
} from './local-model';
import type { EstimateTurn, FoodClaim } from './types';

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

export async function localEstimate(turns: EstimateTurn[]): Promise<EstimateResult> {
  const firstUser = turns.find((t) => t.role === 'user');
  if (!firstUser) return { ok: false, message: 'Nothing to estimate yet.' };

  let raw: string;
  try {
    raw = await runOnLocalContext((ctx) =>
      ctx
        .completion({
          messages: buildMessages(turns),
          jinja: true, // apply the model's embedded chat template (vision tokens)
          n_predict: 1536, // a 6-item claim is ~500 tokens; large multi-item meals can
          //                   exceed 1024 and truncate to unparseable JSON, so give headroom
          temperature: 0,
          response_format: CLAIM_RESPONSE_FORMAT,
        })
        .then((r) => r.text)
    );
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
