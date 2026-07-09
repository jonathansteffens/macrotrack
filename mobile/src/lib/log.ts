import { getUserDb } from './db';
import { fmtGrams, rescaleMacros, scaleMacros, ZERO_MACROS } from './macros';
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
  unit?: string | null;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sugar: number | null;
  sodium_mg: number | null;
  sat_fat: number | null;
  cholesterol_mg: number | null;
  calcium_mg: number | null;
  iron_mg: number | null;
  potassium_mg: number | null;
  source: string;
  origin?: string | null;
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
    unit: r.unit === 'ml' ? 'ml' : 'g',
    macros: {
      kcal: r.kcal,
      protein: r.protein,
      carbs: r.carbs,
      fat: r.fat,
      fiber: r.fiber,
      sugar: r.sugar,
      sodiumMg: r.sodium_mg,
      satFat: r.sat_fat,
      cholesterolMg: r.cholesterol_mg,
      calciumMg: r.calcium_mg,
      ironMg: r.iron_mg,
      potassiumMg: r.potassium_mg,
    },
    source: r.source as LogEntry['source'],
    origin: (r.origin as LogEntry['origin']) ?? null,
  };
}

export async function logFood(
  food: FoodItem,
  opts: {
    day: string;
    meal: MealType;
    grams: number;
    quantityDesc: string;
    /**
     * The flow that created this entry, when it isn't the plain food search —
     * 'assist' tags an AI-review log so it carries the "AI" provenance chip even
     * though its macros come from the canonical DB (`source` still records the
     * real macro provenance). Omitted → a normal DB/custom/barcode log.
     */
    origin?: LogEntry['origin'];
  }
): Promise<number> {
  const m = scaleMacros(food.per100, opts.grams);
  const res = await getUserDb().runAsync(
    `INSERT INTO log_entries
       (day, ts, meal, food_name, food_ref, quantity_desc, grams,
        kcal, protein, carbs, fat, fiber, sugar, sodium_mg,
        sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg, unit, source, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    m.satFat,
    m.cholesterolMg,
    m.calciumMg,
    m.ironMg,
    m.potassiumMg,
    food.unit ?? 'g',
    food.source,
    opts.origin ?? null
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
        kcal, protein, carbs, fat, fiber, sugar, sodium_mg,
        sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg, unit, source)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'g', 'ai_estimate')`,
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
    opts.macros.sodiumMg,
    opts.macros.satFat,
    opts.macros.cholesterolMg,
    opts.macros.calciumMg,
    opts.macros.ironMg,
    opts.macros.potassiumMg
  );
  return res.lastInsertRowId;
}

/**
 * Re-log existing entries into a day + meal: same foods and amounts, fresh
 * timestamps. Macros are copied from the stored snapshots, so this works even
 * if the source foods were since deleted. Used by "copy yesterday" and the
 * habit chip.
 */
export async function relogEntries(
  entries: LogEntry[],
  day: string,
  meal: MealType
): Promise<number[]> {
  const db = getUserDb();
  const ids: number[] = [];
  for (const e of entries) {
    const res = await db.runAsync(
      `INSERT INTO log_entries
         (day, ts, meal, food_name, food_ref, quantity_desc, grams,
          kcal, protein, carbs, fat, fiber, sugar, sodium_mg,
          sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg, unit, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      day,
      new Date().toISOString(),
      meal,
      e.foodName,
      e.foodRef,
      e.quantityDesc,
      e.grams,
      e.macros.kcal,
      e.macros.protein,
      e.macros.carbs,
      e.macros.fat,
      e.macros.fiber,
      e.macros.sugar,
      e.macros.sodiumMg,
      e.macros.satFat,
      e.macros.cholesterolMg,
      e.macros.calciumMg,
      e.macros.ironMg,
      e.macros.potassiumMg,
      e.unit ?? 'g',
      e.source
    );
    ids.push(res.lastInsertRowId);
  }
  return ids;
}

/** Distinct day keys with at least one entry in [from, to] (inclusive) — one
 *  cheap query to mark days on the calendar. */
export async function daysWithEntries(from: string, to: string): Promise<Set<string>> {
  const rows = await getUserDb().getAllAsync<{ day: string }>(
    'SELECT DISTINCT day FROM log_entries WHERE day >= ? AND day <= ?',
    from,
    to
  );
  return new Set(rows.map((r) => r.day));
}

/** Meals that have at least one entry on `day` (for "copy yesterday"). */
export async function mealsLoggedOn(day: string): Promise<Set<MealType>> {
  const rows = await getUserDb().getAllAsync<{ meal: string }>(
    'SELECT DISTINCT meal FROM log_entries WHERE day = ?',
    day
  );
  return new Set(rows.map((r) => r.meal as MealType));
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
    sat_fat: number | null;
    cholesterol_mg: number | null;
    calcium_mg: number | null;
    iron_mg: number | null;
    potassium_mg: number | null;
  }>(
    `SELECT SUM(kcal) kcal, SUM(protein) protein, SUM(carbs) carbs, SUM(fat) fat,
            SUM(fiber) fiber, SUM(sugar) sugar, SUM(sodium_mg) sodium_mg,
            SUM(sat_fat) sat_fat, SUM(cholesterol_mg) cholesterol_mg,
            SUM(calcium_mg) calcium_mg, SUM(iron_mg) iron_mg,
            SUM(potassium_mg) potassium_mg
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
    satFat: r.sat_fat,
    cholesterolMg: r.cholesterol_mg,
    calciumMg: r.calcium_mg,
    ironMg: r.iron_mg,
    potassiumMg: r.potassium_mg,
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
       kcal = ?, protein = ?, carbs = ?, fat = ?, fiber = ?, sugar = ?, sodium_mg = ?,
       sat_fat = ?, cholesterol_mg = ?, calcium_mg = ?, iron_mg = ?, potassium_mg = ?
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
    m.satFat,
    m.cholesterolMg,
    m.calciumMg,
    m.ironMg,
    m.potassiumMg,
    id
  );
}

/**
 * Swap the food an entry points at (the "wrong food" fix). Keeps the logged
 * amount, but re-derives macros from the new food's per-100 basis and rewrites
 * the identity fields (name/ref/unit/source). If the entry has no gram weight
 * its macros can't be rescaled, so only the identity is swapped.
 */
export async function updateEntryFood(id: number, food: FoodItem): Promise<void> {
  const entry = await getEntry(id);
  if (!entry) return;
  const foodName = food.brand ? `${food.name} (${food.brand})` : food.name;
  const unit = food.unit ?? 'g';
  const m = entry.grams != null ? scaleMacros(food.per100, entry.grams) : entry.macros;
  const quantityDesc =
    entry.grams != null ? `${fmtGrams(entry.grams)} ${unit}` : entry.quantityDesc;
  await getUserDb().runAsync(
    `UPDATE log_entries SET food_ref = ?, food_name = ?, quantity_desc = ?, unit = ?, source = ?,
       kcal = ?, protein = ?, carbs = ?, fat = ?, fiber = ?, sugar = ?, sodium_mg = ?,
       sat_fat = ?, cholesterol_mg = ?, calcium_mg = ?, iron_mg = ?, potassium_mg = ?
     WHERE id = ?`,
    food.ref,
    foodName,
    quantityDesc,
    unit,
    food.source,
    m.kcal,
    m.protein,
    m.carbs,
    m.fat,
    m.fiber,
    m.sugar,
    m.sodiumMg,
    m.satFat,
    m.cholesterolMg,
    m.calciumMg,
    m.ironMg,
    m.potassiumMg,
    id
  );
}

export async function updateEntryMeal(id: number, meal: MealType): Promise<void> {
  await getUserDb().runAsync('UPDATE log_entries SET meal = ? WHERE id = ?', meal, id);
}

export async function deleteEntry(id: number): Promise<void> {
  await getUserDb().runAsync('DELETE FROM log_entries WHERE id = ?', id);
}

/** Delete a specific set of entries (undo of a batch quick-log). */
export async function deleteEntries(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await getUserDb().runAsync(`DELETE FROM log_entries WHERE id IN (${placeholders})`, ...ids);
}
