import type Anthropic from '@anthropic-ai/sdk';

import { describeError, makeClient, NO_KEY_MESSAGE } from './client';
import { checkResponse, sanitizeClaim, userContentBlocks, type EstimateResult } from './estimator';
import type { ClaimItem, EstimateTurn, FoodClaim } from './types';

/**
 * Local-model stand-in: the same estimate() contract as the cloud engine,
 * implemented as a pipeline of three small Haiku "subagents". The
 * decomposition mirrors how the Phase 3 on-device model will work — small
 * models do markedly better on one focused job per call than on the full
 * task, and each stage's (input, output) pairs become per-stage fine-tuning
 * data. Vision is only needed in stage 1, exactly like a local pipeline
 * where the vision encoder runs once.
 *
 *   Stage 1  IDENTIFY  (sees photo/text) → list of foods + prep + quantity cues
 *   Stage 2  QUANTIFY  (text only)       → grams, confidence, search terms, est_per100
 *   Stage 3  CLARIFY   (text only)       → questions policy + meal guess
 *
 * Swapping in the real local model later = replacing the runStage() calls
 * with on-device inference behind the same schemas.
 */

const STANDIN_MODEL = 'claude-haiku-4-5';

// ---------- Stage 1: identify ----------

const IDENTIFY_SYSTEM = `You identify foods for a nutrition tracker. Given a meal description and/or photo, list each distinct food or beverage the person consumed. Decompose mixed dishes into main components (a burrito → tortilla, rice, beans, meat, cheese) unless it is a packaged/standard item. Include likely invisible items: cooking oil or butter for fried/sautéed foods, dressing on salads, sugar in drinks. For each item record any quantity clue from the text or image (count, container size, plate coverage). Do not estimate grams or nutrition — that is another component's job.`;

const IDENTIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prep: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Preparation affecting nutrition, or null',
          },
          quantity_cue: {
            type: 'string',
            description: 'Quantity evidence, e.g. "two eggs", "covers half a dinner plate"',
          },
        },
        required: ['name', 'prep', 'quantity_cue'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

type IdentifyOutput = {
  items: { name: string; prep: string | null; quantity_cue: string }[];
};

// ---------- Stage 2: quantify ----------

const QUANTIFY_SYSTEM = `You estimate portions for a nutrition tracker. You receive a list of identified foods with quantity clues. For each item estimate grams consumed, using everyday anchors: a chicken breast is 150-220 g, a slice of sandwich bread ~30 g, an egg ~50 g, a cup of cooked rice ~160 g, a tablespoon of oil ~14 g; assume a standard 26 cm dinner plate for coverage-based clues.

For each item also provide:
- db_search_terms: search phrases matching USDA-style generic descriptions (e.g. "chicken breast roasted skinless"), reflecting the PREPARED state, most specific first. A food database supplies final nutrition from these.
- est_per100: your own per-100g estimate (kcal, protein, carbs, fat), used only if the database has no match — make it realistic.
- confidence: 0.9+ named food with stated quantity; 0.6-0.9 clear food, estimated portion; below 0.6 real uncertainty.

Echo every item you were given (same names, same order, keep prep).`;

const QUANTIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prep: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          grams: { type: 'number' },
          confidence: { type: 'number' },
          db_search_terms: { type: 'array', items: { type: 'string' } },
          est_per100: {
            type: 'object',
            properties: {
              kcal: { type: 'number' },
              protein: { type: 'number' },
              carbs: { type: 'number' },
              fat: { type: 'number' },
            },
            required: ['kcal', 'protein', 'carbs', 'fat'],
            additionalProperties: false,
          },
        },
        required: ['name', 'prep', 'grams', 'confidence', 'db_search_terms', 'est_per100'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

type QuantifyOutput = { items: ClaimItem[] };

// ---------- Stage 3: clarify ----------

const CLARIFY_SYSTEM = `You decide whether a nutrition estimate needs clarification from the user. You receive estimated items with confidence scores plus the conversation so far.

Ask a question ONLY when the answer would change the day's totals meaningfully (roughly >75 kcal or >8 g protein swing) — typically hidden fats, ambiguous portion size, or ambiguous food identity. Never more than 2 questions. Never ask about things reasonably inferable. If the user already answered questions in the conversation, do not re-ask; only ask something new if still critical. When nothing is worth asking, set needs_clarification false and questions [].

Also classify the meal (breakfast/lunch/dinner/snack) from the foods and any time context; default snack.`;

const CLARIFY_SCHEMA = {
  type: 'object',
  properties: {
    needs_clarification: { type: 'boolean' },
    questions: { type: 'array', items: { type: 'string' } },
    meal_guess: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
  },
  required: ['needs_clarification', 'questions', 'meal_guess'],
  additionalProperties: false,
} as const;

type ClarifyOutput = Pick<FoodClaim, 'needs_clarification' | 'questions' | 'meal_guess'>;

// ---------- Pipeline ----------

export async function localEstimate(turns: EstimateTurn[]): Promise<EstimateResult> {
  const client = await makeClient();
  if (!client) return { ok: false, needsKey: true, message: NO_KEY_MESSAGE };

  const firstUser = turns.find((t) => t.role === 'user');
  if (!firstUser || firstUser.role !== 'user') {
    return { ok: false, message: 'Nothing to estimate yet.' };
  }
  const context = conversationContext(turns);

  try {
    // Stage 1 — identify (the only stage that sees the image)
    const identifyContent = [...userContentBlocks(firstUser.input)];
    if (context) identifyContent.push({ type: 'text', text: context });
    const identified = await runStage<IdentifyOutput>(
      client,
      IDENTIFY_SYSTEM,
      IDENTIFY_SCHEMA,
      identifyContent
    );
    if (identified.items.length === 0) {
      return { ok: false, message: 'No foods were recognized. Try describing the meal.' };
    }

    // Stage 2 — quantify
    const quantified = await runStage<QuantifyOutput>(client, QUANTIFY_SYSTEM, QUANTIFY_SCHEMA, [
      {
        type: 'text',
        text:
          `Identified items:\n${JSON.stringify(identified.items, null, 1)}\n\n` +
          `Original description: ${firstUser.input.text?.trim() || '(photo only)'}${context ? `\n\n${context}` : ''}`,
      },
    ]);

    // Stage 3 — clarify
    const clarified = await runStage<ClarifyOutput>(client, CLARIFY_SYSTEM, CLARIFY_SCHEMA, [
      {
        type: 'text',
        text:
          `Estimated items:\n${JSON.stringify(quantified.items, null, 1)}` +
          `${context ? `\n\n${context}` : ''}`,
      },
    ]);

    return {
      ok: true,
      claim: sanitizeClaim({
        items: quantified.items,
        needs_clarification: clarified.needs_clarification,
        questions: clarified.questions,
        meal_guess: clarified.meal_guess,
      }),
    };
  } catch (e) {
    if (e instanceof StageError) return { ok: false, message: e.message };
    return { ok: false, ...describeError(e) };
  }
}

class StageError extends Error {}

async function runStage<T>(
  client: Anthropic,
  system: string,
  schema: Record<string, unknown>,
  content: Anthropic.ContentBlockParam[]
): Promise<T> {
  const response = await client.messages.create({
    model: STANDIN_MODEL,
    max_tokens: 2048,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  const text = checkResponse(response);
  if (typeof text !== 'string') throw new StageError(text.message);
  return JSON.parse(text) as T;
}

/** Flatten clarification rounds into plain-text context for the stages. */
function conversationContext(turns: EstimateTurn[]): string | null {
  const parts: string[] = [];
  let seenFirstUser = false;
  for (const turn of turns) {
    if (turn.role === 'user') {
      if (!seenFirstUser) {
        seenFirstUser = true;
        continue;
      }
      parts.push(`User answered: ${turn.input.text ?? ''}`);
    } else {
      parts.push(
        `Previous estimate: ${JSON.stringify({ items: turn.claim.items, questions: turn.claim.questions })}`
      );
    }
  }
  return parts.length ? `Conversation so far:\n${parts.join('\n')}` : null;
}
