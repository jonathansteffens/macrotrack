import { getUserDb } from './db';

/**
 * Hidden developer mode — unlocked by long-pressing the version line on the
 * About screen. Gates developer-facing affordances (currently the ai_events
 * training export) out of the UI ordinary users see: for them the export is a
 * dead end (the file goes nowhere), while for the developer it is the training
 * data pipeline.
 */

const KEY = 'dev_mode';

export async function isDevMode(): Promise<boolean> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = '${KEY}'`
  );
  return row?.value === '1';
}

export async function setDevMode(on: boolean): Promise<void> {
  await getUserDb().runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('${KEY}', ?)`,
    on ? '1' : '0'
  );
}
