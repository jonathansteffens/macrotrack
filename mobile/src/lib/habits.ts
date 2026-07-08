import { addDays, todayKey } from './dates';
import { getUserDb } from './db';
import { entriesForDay } from './log';
import { normName } from './norm';
import type { LogEntry, MealType } from './types';

/**
 * Habit detection for the "log your usual …" chip: pure frequency counting
 * over log_entries, no ML. A "combo" is the exact set of foods a meal was
 * logged with on a given day; the same set showing up on ≥3 of the last 14
 * days is a habit worth offering back as a one-tap log.
 */

export const HABIT_WINDOW_DAYS = 14;
export const HABIT_MIN_DAYS = 3;

/** One logged item, reduced to what habit matching needs. */
export type HabitRow = { day: string; itemKey: string };

export type HabitSignature = {
  /** Item keys sorted and newline-joined (name keys can contain spaces). */
  signature: string;
  /** Distinct days the combo was logged. */
  days: number;
  /** Most recent day it was logged (source of the amounts to re-log). */
  latestDay: string;
};

/** Stable identity for a logged item: the food ref, or its normalized name. */
export function habitItemKey(foodRef: string | null, foodName: string): string {
  return foodRef ?? `name:${normName(foodName)}`;
}

/**
 * Pure core: group rows by day, take each day's de-duplicated sorted item set
 * as its signature, and return the signature seen on the most days (ties go
 * to the most recent) if it clears `minDays`. Null when no habit exists.
 */
export function findUsualSignature(
  rows: HabitRow[],
  minDays = HABIT_MIN_DAYS
): HabitSignature | null {
  const byDay = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = byDay.get(r.day);
    if (!set) byDay.set(r.day, (set = new Set()));
    set.add(r.itemKey);
  }

  const bySig = new Map<string, { days: number; latestDay: string }>();
  for (const [day, set] of byDay) {
    const sig = [...set].sort().join('\n');
    const cur = bySig.get(sig);
    if (cur) {
      cur.days++;
      if (day > cur.latestDay) cur.latestDay = day;
    } else {
      bySig.set(sig, { days: 1, latestDay: day });
    }
  }

  let best: HabitSignature | null = null;
  for (const [signature, v] of bySig) {
    if (v.days < minDays) continue;
    if (!best || v.days > best.days || (v.days === best.days && v.latestDay > best.latestDay)) {
      best = { signature, ...v };
    }
  }
  return best;
}

export type UsualCombo = {
  meal: MealType;
  /** How many of the last 14 days the combo was logged. */
  days: number;
  /** Snapshot entries from the most recent occurrence, ready to re-log. */
  entries: LogEntry[];
  kcal: number;
};

/**
 * The user's usual combo for `meal`, from the last 14 full days (yesterday and
 * back, so today's half-logged meal never counts toward itself).
 */
export async function usualComboForMeal(meal: MealType): Promise<UsualCombo | null> {
  const today = todayKey();
  const rows = await getUserDb().getAllAsync<{
    day: string;
    food_ref: string | null;
    food_name: string;
  }>(
    'SELECT day, food_ref, food_name FROM log_entries WHERE meal = ? AND day BETWEEN ? AND ?',
    meal,
    addDays(today, -HABIT_WINDOW_DAYS),
    addDays(today, -1)
  );
  const best = findUsualSignature(
    rows.map((r) => ({ day: r.day, itemKey: habitItemKey(r.food_ref, r.food_name) }))
  );
  if (!best) return null;

  const keys = new Set(best.signature.split('\n'));
  const entries = (await entriesForDay(best.latestDay)).filter(
    (e) => e.meal === meal && keys.has(habitItemKey(e.foodRef, e.foodName))
  );
  if (entries.length === 0) return null;
  return { meal, days: best.days, entries, kcal: entries.reduce((s, e) => s + e.macros.kcal, 0) };
}
