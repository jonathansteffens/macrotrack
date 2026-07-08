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
  streak: number; // consecutive logged days ending today or yesterday
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

  return { days, loggedDays: logged.length, averages, streak: await getStreak() };
}

/** Consecutive logged days, counting back from today (or yesterday if today is empty). */
async function getStreak(): Promise<number> {
  const rows = await getUserDb().getAllAsync<{ day: string }>(
    'SELECT DISTINCT day FROM log_entries ORDER BY day DESC LIMIT 400'
  );
  const loggedSet = new Set(rows.map((r) => r.day));
  let day = todayKey();
  if (!loggedSet.has(day)) day = addDays(day, -1);
  let streak = 0;
  while (loggedSet.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}
