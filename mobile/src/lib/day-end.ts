import { DEFAULT_DAY_END_HOUR, setDayEndHourCache } from './dates';
import { getUserDb } from './db';

/**
 * The "day ends at" setting: entries logged before this hour (default 3 AM)
 * count toward the previous day, so late-night eating lands on the evening it
 * belongs to. Persisted in settings and mirrored into the dates.ts cache,
 * which every day-key helper reads.
 */

export const DAY_END_OPTIONS = [0, 1, 2, 3, 4, 5] as const;

export function dayEndLabel(hour: number): string {
  return hour === 0 ? 'Midnight' : `${hour} AM`;
}

export async function getDayEndHour(): Promise<number> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'day_end_hour'"
  );
  const hour = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(hour) ? hour : DEFAULT_DAY_END_HOUR;
}

export async function setDayEndHour(hour: number): Promise<void> {
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('day_end_hour', ?)",
    String(hour)
  );
  setDayEndHourCache(hour);
}

/** Load the persisted hour into the day-key cache. Called once after initDb(). */
export async function loadDayEndHour(): Promise<void> {
  setDayEndHourCache(await getDayEndHour());
}
