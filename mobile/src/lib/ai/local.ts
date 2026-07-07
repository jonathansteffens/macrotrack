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

// Chat content is either a plain string or typed blocks (text + image).
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; content: string };

function userMessage(input: { text?: string; imageBase64?: string }): Message {
  const content: ContentBlock[] = [];
  if (input.imageBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` },
    });
  }
  content.push({ type: 'text', text: input.text?.trim() || 'Estimate the nutrition of this meal.' });
  return { role: 'user', content };
}

function buildMessages(turns: EstimateTurn[]): Message[] {
  const messages: Message[] = [{ role: 'system', content: ESTIMATOR_SYSTEM_PROMPT }];
  for (const turn of turns) {
    messages.push(
      turn.role === 'assistant'
        ? { role: 'assistant', content: JSON.stringify(turn.claim) }
        : userMessage(turn.input)
    );
  }
  return messages;
}

export async function localEstimate(turns: EstimateTurn[]): Promise<EstimateResult> {
  const firstUser = turns.find((t) => t.role === 'user');
  if (!firstUser) return { ok: false, message: 'Nothing to estimate yet.' };

  try {
    const text = await runOnLocalContext((ctx) =>
      ctx
        .completion({
          messages: buildMessages(turns),
          jinja: true, // apply the model's embedded chat template (vision tokens)
          n_predict: 1024, // a 6-item claim is ~500 tokens; 1024 is a safe ceiling
          temperature: 0,
          response_format: CLAIM_RESPONSE_FORMAT,
        })
        .then((r) => r.text)
    );
    const claim = JSON.parse(text) as FoodClaim;
    return { ok: true, claim: sanitizeClaim(claim) };
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
    if (e instanceof SyntaxError) {
      return { ok: false, message: 'Could not parse the on-device model response. Please try again.' };
    }
    return { ok: false, message: 'On-device estimate failed. Please try again.' };
  }
}
