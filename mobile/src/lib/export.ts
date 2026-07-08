import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { dayKey } from './dates';
import { getUserDb } from './db';

/**
 * Data export via the system share sheet. The AI training export is the
 * bridge to the fine-tuning workstation: it carries every estimator
 * interaction plus the user's final corrections (see tools/finetune/).
 */

async function shareText(filename: string, content: string): Promise<void> {
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  await Sharing.shareAsync(file.uri, { dialogTitle: filename });
}

/**
 * ai_events as JSONL, one saved estimator interaction per line, exactly per
 * docs/ai-events-format.md v1. Rows recorded before the v1 columns existed
 * lack a faithful model_claim/final_claim pair and are skipped. Capped at the
 * most recent 5,000 events (older rows have diminishing training value).
 */
export async function exportTrainingData(): Promise<number> {
  const rows = await getUserDb().getAllAsync<{
    ts: string;
    model: string | null;
    input_text: string | null;
    model_claim_json: string;
    final_claim_json: string | null;
    edits_json: string | null;
    clarification_json: string | null;
  }>(
    `SELECT ts, model, input_text, model_claim_json, final_claim_json, edits_json,
            clarification_json
       FROM ai_events WHERE model_claim_json IS NOT NULL
      ORDER BY id DESC LIMIT 5000`
  );
  rows.reverse(); // oldest first in the file
  const lines = rows.map((r) =>
    JSON.stringify({
      v: 1,
      ts: r.ts,
      model: r.model ?? 'unknown',
      user_text: r.input_text ?? '',
      model_claim: JSON.parse(r.model_claim_json),
      final_claim: r.final_claim_json ? JSON.parse(r.final_claim_json) : null,
      edits: r.edits_json ? JSON.parse(r.edits_json) : [],
      ...(r.clarification_json ? { clarification: JSON.parse(r.clarification_json) } : {}),
    })
  );
  if (lines.length > 0) {
    const stamp = dayKey(new Date()).replace(/-/g, '');
    await shareText(`ai-events-${stamp}.jsonl`, lines.join('\n') + '\n');
  }
  return lines.length;
}

/** Full log + weights as a single JSON document (backup / analysis). */
export async function exportFoodLog(): Promise<number> {
  const db = getUserDb();
  const entries = await db.getAllAsync('SELECT * FROM log_entries ORDER BY day, ts');
  const weights = await db.getAllAsync('SELECT * FROM weights ORDER BY day');
  const customFoods = await db.getAllAsync('SELECT * FROM custom_foods ORDER BY id');
  await shareText(
    'macrotrack-log.json',
    JSON.stringify({ exported_at: new Date().toISOString(), entries, weights, customFoods }, null, 1)
  );
  return entries.length;
}
