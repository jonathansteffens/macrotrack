import { getUserDb } from '../db';
import type { EstimateTurn } from './types';

/**
 * Every AI logging interaction is recorded as (conversation, what the user
 * actually logged after edits). These pairs are the training data for the
 * Phase 3 local-model fine-tune — the user's corrections are the label.
 * Image bytes are NOT stored (only a flag), to keep the DB small.
 */

export type LoggedCorrection = {
  name: string;
  matchedRef: string | null;
  claimedGrams: number;
  loggedGrams: number;
  kcal: number;
};

export async function recordAiEvent(
  turns: EstimateTurn[],
  logged: LoggedCorrection[]
): Promise<void> {
  const firstUser = turns.find((t) => t.role === 'user');
  const hadImage = turns.some((t) => t.role === 'user' && !!t.input.imageBase64);
  const stripped = turns.map((t) =>
    t.role === 'user'
      ? { role: t.role, input: { text: t.input.text, hadImage: !!t.input.imageBase64 } }
      : t
  );
  await getUserDb().runAsync(
    'INSERT INTO ai_events (ts, input_text, had_image, turns_json, logged_json) VALUES (?, ?, ?, ?, ?)',
    new Date().toISOString(),
    firstUser?.role === 'user' ? (firstUser.input.text ?? null) : null,
    hadImage ? 1 : 0,
    JSON.stringify(stripped),
    JSON.stringify(logged)
  );
}
