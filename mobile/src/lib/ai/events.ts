import { getUserDb } from '../db';
import { normName } from '../norm';
import type { MealType } from '../types';
import { LOCAL_MODEL_RELEASE_TAG } from './local-model';
import type { ClaimItem, EstimateTurn, FoodClaim } from './types';

/**
 * Every SAVED AI logging interaction is recorded as (what the model claimed,
 * what the user actually logged after edits). These rows are both the training
 * data for the next estimator fine-tune (exported per
 * docs/ai-events-format.md v1) and the per-food correction memory that
 * pre-adjusts future suggestions — one pipeline, two consumers.
 * Image bytes are NOT stored (only a flag), to keep the DB small.
 */

export type LoggedCorrection = {
  name: string;
  matchedRef: string | null;
  claimedGrams: number;
  loggedGrams: number;
  kcal: number;
};

/** Machine-readable edit summary — exactly the shapes in the v1 format doc. */
export type AiEventEdit =
  | { kind: 'grams'; item: string; from: number; to: number }
  | { kind: 'add'; item: string }
  | { kind: 'remove'; item: string }
  | { kind: 'meal'; from: MealType; to: MealType };

/** One reviewed item as it was actually saved into the log. */
export type SavedAiItem = {
  /** The claim item this row came from (matched by identity for diffing). */
  claim: ClaimItem;
  /** Name as saved — the DB match's canonical name when one was chosen. */
  name: string;
  grams: number;
  /** Canonical DB name of the resolved food, null for pure AI estimates. */
  matchedName: string | null;
};

/**
 * FoodClaim-shaped record of what was saved: matched items carry the chosen
 * food's canonical DB name in db_search_terms[0]; unmatched ones keep the
 * model's est_per100 (those numbers are what actually got logged).
 */
function finalClaimFor(items: SavedAiItem[], meal: MealType) {
  return {
    items: items.map((s) => ({
      name: s.name,
      grams: s.grams,
      ...(s.matchedName != null
        ? { db_search_terms: [s.matchedName] }
        : { est_per100: s.claim.est_per100 }),
    })),
    meal_guess: meal,
  };
}

/** Diff the emitted claim against what was saved. (The review UI has no way
 *  to add items, so 'add' edits can't occur — the kind exists for the format.) */
function editsFor(claim: FoodClaim, items: SavedAiItem[], meal: MealType): AiEventEdit[] {
  const edits: AiEventEdit[] = [];
  for (const ci of claim.items) {
    const saved = items.find((s) => s.claim === ci);
    if (!saved) {
      edits.push({ kind: 'remove', item: ci.name });
    } else if (saved.grams !== Math.round(ci.grams)) {
      // The review screen seeds with the rounded claim grams, so a rounded
      // match means "untouched" — anything else is a real correction.
      edits.push({ kind: 'grams', item: ci.name, from: ci.grams, to: saved.grams });
    }
  }
  if (meal !== claim.meal_guess) edits.push({ kind: 'meal', from: claim.meal_guess, to: meal });
  return edits;
}

/** The first answered clarification round, if the conversation had one. */
function clarificationFor(
  turns: EstimateTurn[]
): { questions: string[]; answer_text: string } | null {
  for (let i = 0; i < turns.length - 1; i++) {
    const turn = turns[i];
    const next = turns[i + 1];
    if (
      turn.role === 'assistant' &&
      turn.claim.needs_clarification &&
      turn.claim.questions.length > 0 &&
      next.role === 'user' &&
      next.input.text
    ) {
      return { questions: turn.claim.questions, answer_text: next.input.text };
    }
  }
  return null;
}

export async function recordAiEvent(
  turns: EstimateTurn[],
  logged: LoggedCorrection[],
  saved: { claim: FoodClaim; items: SavedAiItem[]; meal: MealType }
): Promise<void> {
  const firstUser = turns.find((t) => t.role === 'user');
  const hadImage = turns.some((t) => t.role === 'user' && !!t.input.imageBase64);
  const stripped = turns.map((t) =>
    t.role === 'user'
      ? { role: t.role, input: { text: t.input.text, hadImage: !!t.input.imageBase64 } }
      : t
  );
  const clarification = clarificationFor(turns);
  await getUserDb().runAsync(
    `INSERT INTO ai_events
       (ts, input_text, had_image, turns_json, logged_json,
        model, model_claim_json, final_claim_json, edits_json, clarification_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    new Date().toISOString(),
    firstUser?.role === 'user' ? (firstUser.input.text ?? null) : null,
    hadImage ? 1 : 0,
    JSON.stringify(stripped),
    JSON.stringify(logged),
    LOCAL_MODEL_RELEASE_TAG,
    JSON.stringify(saved.claim),
    JSON.stringify(finalClaimFor(saved.items, saved.meal)),
    JSON.stringify(editsFor(saved.claim, saved.items, saved.meal)),
    clarification ? JSON.stringify(clarification) : null
  );
}

/**
 * Per-food correction memory, read straight off the recorded grams edits (the
 * format doc mandates a single pipeline — no separate corrections table).
 * Returns the median corrected grams once a food has ≥2 corrections, else
 * null. SQLite's json_each unpacks the edits; name matching is done in JS so
 * it can share normName with the rest of the app.
 */
export async function usualGramsFor(name: string): Promise<number | null> {
  const key = normName(name);
  const rows = await getUserDb().getAllAsync<{ item: string | null; to_g: unknown }>(
    `SELECT json_extract(e.value, '$.item') AS item, json_extract(e.value, '$.to') AS to_g
       FROM ai_events a, json_each(a.edits_json) e
      WHERE a.edits_json IS NOT NULL AND json_extract(e.value, '$.kind') = 'grams'
      ORDER BY a.id DESC LIMIT 500`
  );
  const values = rows
    .filter((r) => r.item != null && normName(r.item) === key)
    .map((r) => Number(r.to_g))
    .filter((g) => Number.isFinite(g) && g > 0);
  if (values.length < 2) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return Math.round(median);
}
