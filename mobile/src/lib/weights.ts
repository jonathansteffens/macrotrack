import { addDays, lastNDays, todayKey } from './dates';
import { getUserDb } from './db';

/**
 * Daily body-weight log. Unit-agnostic — the value is whatever the user
 * consistently enters (lbs or kg). One entry per day, latest wins.
 */

export type WeightEntry = { day: string; weight: number };

/**
 * Format a body weight for display: a plain number to one decimal. Body weight
 * is unit-agnostic (lbs or kg, whatever the user consistently enters), so it is
 * NOT formatted with fmtGrams — it isn't grams.
 */
export function fmtWeight(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

export async function logWeight(weight: number, day = todayKey()): Promise<void> {
  await getUserDb().runAsync(
    'INSERT OR REPLACE INTO weights (day, weight, ts) VALUES (?, ?, ?)',
    day,
    weight,
    new Date().toISOString()
  );
}

export async function latestWeight(): Promise<WeightEntry | null> {
  return getUserDb().getFirstAsync<WeightEntry>(
    'SELECT day, weight FROM weights ORDER BY day DESC LIMIT 1'
  );
}

/** Weights within the last `nDays`, oldest first (sparse — only logged days). */
export async function weightsForRange(nDays: number): Promise<WeightEntry[]> {
  const from = addDays(todayKey(), -(nDays - 1));
  return getUserDb().getAllAsync<WeightEntry>(
    'SELECT day, weight FROM weights WHERE day >= ? ORDER BY day',
    from
  );
}

/**
 * Weight series aligned to the last `nDays` day keys with gaps carried
 * forward from the previous known value (0 before the first entry), plus the
 * net change across the range when at least two entries exist.
 */
export async function weightTrend(nDays: number): Promise<{
  series: number[];
  entries: WeightEntry[];
  change: number | null;
}> {
  const entries = await weightsForRange(nDays);
  const byDay = new Map(entries.map((e) => [e.day, e.weight]));
  let current = 0;
  const series = lastNDays(nDays).map((day) => {
    current = byDay.get(day) ?? current;
    return current;
  });
  const change =
    entries.length >= 2 ? entries[entries.length - 1].weight - entries[0].weight : null;
  return { series, entries, change };
}
