import { getUserDb } from './db';
import { lastNDays, todayKey, addDays } from './dates';

export type DayTotal = {
  day: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  logged: boolean;
};

export type TrendSummary = {
  days: DayTotal[]; // oldest first, zero-filled
  loggedDays: number;
  avgKcal: number; // averages over logged days only
  avgProtein: number;
  avgCarbs: number;
  avgFat: number;
  avgFiber: number;
  streak: number; // consecutive logged days ending today or yesterday
};

export async function getTrends(nDays: number): Promise<TrendSummary> {
  const keys = lastNDays(nDays);
  const rows = await getUserDb().getAllAsync<{
    day: string;
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number | null;
  }>(
    `SELECT day, SUM(kcal) kcal, SUM(protein) protein, SUM(carbs) carbs, SUM(fat) fat, SUM(fiber) fiber
     FROM log_entries WHERE day >= ? GROUP BY day`,
    keys[0]
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const days: DayTotal[] = keys.map((day) => {
    const r = byDay.get(day);
    return r
      ? { day, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber ?? 0, logged: true }
      : { day, kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, logged: false };
  });

  const logged = days.filter((d) => d.logged);
  const avg = (sel: (d: DayTotal) => number) =>
    logged.length ? logged.reduce((s, d) => s + sel(d), 0) / logged.length : 0;

  return {
    days,
    loggedDays: logged.length,
    avgKcal: avg((d) => d.kcal),
    avgProtein: avg((d) => d.protein),
    avgCarbs: avg((d) => d.carbs),
    avgFat: avg((d) => d.fat),
    avgFiber: avg((d) => d.fiber),
    streak: await getStreak(),
  };
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
