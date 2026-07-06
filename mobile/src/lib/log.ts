import { getUserDb } from './db';
import { rescaleMacros, scaleMacros, ZERO_MACROS } from './macros';
import type { FoodItem, LogEntry, Macros, MealType } from './types';

type EntryRow = {
  id: number;
  day: string;
  ts: string;
  meal: string;
  food_name: string;
  food_ref: string | null;
  quantity_desc: string;
  grams: number | null;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sugar: number | null;
  sodium_mg: number | null;
  source: string;
};

function rowToEntry(r: EntryRow): LogEntry {
  return {
    id: r.id,
    day: r.day,
    ts: r.ts,
    meal: r.meal as MealType,
    foodName: r.food_name,
    foodRef: r.food_ref,
    quantityDesc: r.quantity_desc,
    grams: r.grams,
    macros: {
      kcal: r.kcal,
      protein: r.protein,
      carbs: r.carbs,
      fat: r.fat,
      fiber: r.fiber,
      sugar: r.sugar,
      sodiumMg: r.sodium_mg,
    },
    source: r.source as LogEntry['source'],
  };
}

export async function logFood(
  food: FoodItem,
  opts: { day: string; meal: MealType; grams: number; quantityDesc: string }
): Promise<number> {
  const m = scaleMacros(food.per100, opts.grams);
  const res = await getUserDb().runAsync(
    `INSERT INTO log_entries
       (day, ts, meal, food_name, food_ref, quantity_desc, grams,
        kcal, protein, carbs, fat, fiber, sugar, sodium_mg, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    opts.day,
    new Date().toISOString(),
    opts.meal,
    food.brand ? `${food.name} (${food.brand})` : food.name,
    food.ref,
    opts.quantityDesc,
    opts.grams,
    m.kcal,
    m.protein,
    m.carbs,
    m.fat,
    m.fiber,
    m.sugar,
    m.sodiumMg,
    food.source
  );
  return res.lastInsertRowId;
}

/**
 * Log an AI-estimated item that has no database match. Macros come from the
 * model's per-100g estimate, flagged as `ai_estimate` so trends can show
 * data quality.
 */
export async function logAiEstimate(opts: {
  day: string;
  meal: MealType;
  name: string;
  grams: number;
  macros: Macros;
}): Promise<number> {
  const res = await getUserDb().runAsync(
    `INSERT INTO log_entries
       (day, ts, meal, food_name, food_ref, quantity_desc, grams,
        kcal, protein, carbs, fat, fiber, sugar, sodium_mg, source)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_estimate')`,
    opts.day,
    new Date().toISOString(),
    opts.meal,
    opts.name,
    `${Math.round(opts.grams)} g (AI estimate)`,
    opts.grams,
    opts.macros.kcal,
    opts.macros.protein,
    opts.macros.carbs,
    opts.macros.fat,
    opts.macros.fiber,
    opts.macros.sugar,
    opts.macros.sodiumMg
  );
  return res.lastInsertRowId;
}

export async function getEntry(id: number): Promise<LogEntry | null> {
  const r = await getUserDb().getFirstAsync<EntryRow>(
    'SELECT * FROM log_entries WHERE id = ?',
    id
  );
  return r ? rowToEntry(r) : null;
}

export async function entriesForDay(day: string): Promise<LogEntry[]> {
  const rows = await getUserDb().getAllAsync<EntryRow>(
    'SELECT * FROM log_entries WHERE day = ? ORDER BY ts',
    day
  );
  return rows.map(rowToEntry);
}

export async function dayTotals(day: string): Promise<Macros> {
  const r = await getUserDb().getFirstAsync<{
    kcal: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
    fiber: number | null;
    sugar: number | null;
    sodium_mg: number | null;
  }>(
    `SELECT SUM(kcal) kcal, SUM(protein) protein, SUM(carbs) carbs, SUM(fat) fat,
            SUM(fiber) fiber, SUM(sugar) sugar, SUM(sodium_mg) sodium_mg
     FROM log_entries WHERE day = ?`,
    day
  );
  if (!r || r.kcal == null) return ZERO_MACROS;
  return {
    kcal: r.kcal,
    protein: r.protein ?? 0,
    carbs: r.carbs ?? 0,
    fat: r.fat ?? 0,
    fiber: r.fiber,
    sugar: r.sugar,
    sodiumMg: r.sodium_mg,
  };
}

/**
 * Change an entry's quantity. Macros scale proportionally from the stored
 * snapshot, so this works even if the source food was since deleted.
 */
export async function updateEntryQuantity(
  id: number,
  newGrams: number,
  newQuantityDesc: string
): Promise<void> {
  const entry = await getEntry(id);
  if (!entry || entry.grams == null || entry.grams <= 0) return;
  const m = rescaleMacros(entry.macros, newGrams / entry.grams);
  await getUserDb().runAsync(
    `UPDATE log_entries SET grams = ?, quantity_desc = ?,
       kcal = ?, protein = ?, carbs = ?, fat = ?, fiber = ?, sugar = ?, sodium_mg = ?
     WHERE id = ?`,
    newGrams,
    newQuantityDesc,
    m.kcal,
    m.protein,
    m.carbs,
    m.fat,
    m.fiber,
    m.sugar,
    m.sodiumMg,
    id
  );
}

export async function updateEntryMeal(id: number, meal: MealType): Promise<void> {
  await getUserDb().runAsync('UPDATE log_entries SET meal = ? WHERE id = ?', meal, id);
}

export async function deleteEntry(id: number): Promise<void> {
  await getUserDb().runAsync('DELETE FROM log_entries WHERE id = ?', id);
}
