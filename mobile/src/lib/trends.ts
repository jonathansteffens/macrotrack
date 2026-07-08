import { getUserDb } from './db';
import { lastNDays, todayKey, addDays } from './dates';
import { NUTRIENTS, type NutrientKey } from './nutrients';

export type DayTotal = {
  day: string;
  logged: boolean;
  values: Record<NutrientKey, number>; // per-nutrient total for the day
};

export type TrendSummary = {
  days: DayTotal[]; // oldest first, zero-filled
  loggedDays: number;
  averages: Record<NutrientKey, number>; // over logged days only
  loggedLast7: number; // days logged out of the last 7 (kind framing, not a streak)
};

/** camelCase nutrient key → snake_case DB column (sodiumMg → sodium_mg). */
const col = (k: NutrientKey) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

function zeroValues(): Record<NutrientKey, number> {
  const v = {} as Record<NutrientKey, number>;
  for (const n of NUTRIENTS) v[n.key] = 0;
  return v;
}

export async function getTrends(nDays: number): Promise<TrendSummary> {
  const keys = lastNDays(nDays);
  const selects = NUTRIENTS.map((n) => `SUM(${col(n.key)}) AS ${n.key}`).join(', ');
  const rows = await getUserDb().getAllAsync<{ day: string } & Record<string, number | null>>(
    `SELECT day, ${selects} FROM log_entries WHERE day >= ? GROUP BY day`,
    keys[0]
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const days: DayTotal[] = keys.map((day) => {
    const r = byDay.get(day);
    if (!r) return { day, logged: false, values: zeroValues() };
    const values = {} as Record<NutrientKey, number>;
    for (const n of NUTRIENTS) values[n.key] = (r[n.key] as number | null) ?? 0;
    return { day, logged: true, values };
  });

  const logged = days.filter((d) => d.logged);
  const averages = {} as Record<NutrientKey, number>;
  for (const n of NUTRIENTS) {
    averages[n.key] = logged.length
      ? logged.reduce((s, d) => s + d.values[n.key], 0) / logged.length
      : 0;
  }

  return { days, loggedDays: logged.length, averages, loggedLast7: await countLoggedLast7() };
}

/**
 * Days with any entry among the last 7 (including today). Deliberately not a
 * consecutive streak: a missed day just means N drops by one for a week — a
 * one-day gap never zeroes anything, because there is no zero to fall to.
 */
async function countLoggedLast7(): Promise<number> {
  const today = todayKey();
  const row = await getUserDb().getFirstAsync<{ n: number }>(
    'SELECT COUNT(DISTINCT day) AS n FROM log_entries WHERE day BETWEEN ? AND ?',
    addDays(today, -6),
    today
  );
  return row?.n ?? 0;
}
