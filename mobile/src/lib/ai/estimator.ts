import Anthropic from '@anthropic-ai/sdk';

import { describeError, makeClient, NO_KEY_MESSAGE } from './client';
import { getAiModel } from './config';
import { ESTIMATOR_SYSTEM_PROMPT } from './prompt';
import { FOOD_CLAIM_SCHEMA } from './schema';
import type { EstimateInput, EstimateTurn, FoodClaim } from './types';

/**
 * Cloud estimator: one large-model call that does the whole job. The local
 * stand-in (./local.ts) implements the same signature; ./engine.ts picks
 * between them.
 */

export type EstimateResult =
  | { ok: true; claim: FoodClaim }
  | { ok: false; message: string; needsKey?: boolean; needsModel?: boolean };

export function userContentBlocks(input: EstimateInput): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (input.imageBase64) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: input.imageBase64 },
    });
  }
  blocks.push({
    type: 'text',
    text: input.text?.trim() || 'Estimate the nutrition of this meal.',
  });
  return blocks;
}

export async function cloudEstimate(turns: EstimateTurn[]): Promise<EstimateResult> {
  const client = await makeClient();
  if (!client) return { ok: false, needsKey: true, message: NO_KEY_MESSAGE };

  const messages: Anthropic.MessageParam[] = turns.map((turn) =>
    turn.role === 'assistant'
      ? { role: 'assistant', content: JSON.stringify(turn.claim) }
      : { role: 'user', content: userContentBlocks(turn.input) }
  );

  try {
    const response = await client.messages.create({
      model: await getAiModel(),
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: ESTIMATOR_SYSTEM_PROMPT,
      output_config: {
        format: { type: 'json_schema', schema: FOOD_CLAIM_SCHEMA },
      },
      messages,
    });
    const text = checkResponse(response);
    if (typeof text !== 'string') return text;
    return { ok: true, claim: sanitizeClaim(JSON.parse(text)) };
  } catch (e) {
    return { ok: false, ...describeError(e) };
  }
}

/** Shared response validation: refusal/truncation checks, first text block. */
export function checkResponse(
  response: Anthropic.Message
): string | { ok: false; message: string } {
  if (response.stop_reason === 'refusal') {
    return { ok: false, message: 'The model declined this request. Try rephrasing.' };
  }
  if (response.stop_reason === 'max_tokens') {
    return { ok: false, message: 'The response was cut off. Try a simpler description.' };
  }
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) {
    return { ok: false, message: 'The model returned no result. Please try again.' };
  }
  return text;
}

/** Enforce the bounds the schema can't express. */
export function sanitizeClaim(claim: FoodClaim): FoodClaim {
  return {
    ...claim,
    items: claim.items
      .filter((i) => i.grams > 0)
      .map((i) => ({
        ...i,
        grams: Math.min(i.grams, 5000),
        confidence: Math.max(0, Math.min(1, i.confidence)),
      })),
    questions: claim.questions.slice(0, 2),
    needs_clarification: claim.needs_clarification && claim.questions.length > 0,
  };
}
