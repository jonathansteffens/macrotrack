import { getLocalModelStatus } from './ai/local-model';
import { getUserDb } from './db';

/**
 * Cold-start nudge for the on-device AI: after the user's 3rd manual food
 * search (lifetime count, in settings) a one-time dismissible card points out
 * that they could have typed the whole meal instead. Gone for good once
 * dismissed — and moot once the model is downloaded.
 */

const COUNT_KEY = 'manual_search_count';
const DISMISSED_KEY = 'ai_offer_dismissed';
const OFFER_AFTER_SEARCHES = 3;

/** Bump the lifetime manual-search counter (call once per search session). */
export async function recordManualSearch(): Promise<void> {
  await getUserDb().runAsync(
    `INSERT INTO settings (key, value) VALUES ('${COUNT_KEY}', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  );
}

export async function shouldShowAiOffer(): Promise<boolean> {
  if ((await getLocalModelStatus()) !== 'missing') return false; // downloaded or unsupported
  const db = getUserDb();
  const dismissed = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = '${DISMISSED_KEY}'`
  );
  if (dismissed?.value === '1') return false;
  const count = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = '${COUNT_KEY}'`
  );
  return (count ? parseInt(count.value, 10) || 0 : 0) >= OFFER_AFTER_SEARCHES;
}

export async function dismissAiOffer(): Promise<void> {
  await getUserDb().runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('${DISMISSED_KEY}', '1')`
  );
}
