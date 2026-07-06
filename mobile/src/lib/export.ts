import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

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

/** ai_events as JSONL — one (conversation, corrections) pair per line. */
export async function exportTrainingData(): Promise<number> {
  const rows = await getUserDb().getAllAsync<{
    ts: string;
    input_text: string | null;
    had_image: number;
    turns_json: string;
    logged_json: string | null;
  }>('SELECT ts, input_text, had_image, turns_json, logged_json FROM ai_events ORDER BY id');
  const lines = rows.map((r) =>
    JSON.stringify({
      ts: r.ts,
      input_text: r.input_text,
      had_image: !!r.had_image,
      turns: JSON.parse(r.turns_json),
      logged: r.logged_json ? JSON.parse(r.logged_json) : null,
    })
  );
  if (lines.length > 0) {
    await shareText('macrotrack-ai-events.jsonl', lines.join('\n') + '\n');
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
