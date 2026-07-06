import { getFoodsDb, getUserDb } from './db';
import type { FoodItem, Macros, Portion } from './types';

type FoodRow = {
  id: number;
  name: string;
  brand?: string | null;
  category?: string | null;
  kcal: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  sugar: number | null;
  sodium_mg: number | null;
  portions_json: string;
};

function rowMacros(r: FoodRow): Macros {
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

function parsePortions(json: string): Portion[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function usdaRowToFood(r: FoodRow): FoodItem {
  return {
    ref: `usda:${r.id}`,
    source: 'usda',
    name: r.name,
    brand: null,
    category: r.category ?? null,
    per100: rowMacros(r),
    portions: parsePortions(r.portions_json),
  };
}

function customRowToFood(r: FoodRow): FoodItem {
  return {
    ref: `custom:${r.id}`,
    source: 'custom',
    name: r.name,
    brand: r.brand ?? null,
    category: null,
    per100: rowMacros(r),
    portions: parsePortions(r.portions_json),
  };
}

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Function words that hurt matching (e.g. "with" substring-matches "without"). */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

/**
 * Tokenized search over custom foods (first) and the bundled USDA table.
 * Stopwords are dropped, and every remaining token must start a word in the
 * normalized name (word-boundary prefix match). Results whose name starts
 * with the first token rank first, then shorter names.
 */
export async function searchFoods(query: string, limit = 50): Promise<FoodItem[]> {
  const all = normName(query).split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (tokens.length === 0) return [];

  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');
  const params = tokens.map((t) => `% ${escapeLike(t)}%`);
  const prefix = `${escapeLike(tokens[0])}%`;
  const orderBy = `CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm)`;

  const custom = await getUserDb().getAllAsync<FoodRow>(
    `SELECT * FROM custom_foods WHERE ${where} ORDER BY ${orderBy} LIMIT 10`,
    ...params,
    prefix
  );
  const usda = await getFoodsDb().getAllAsync<FoodRow>(
    `SELECT * FROM foods WHERE ${where} ORDER BY ${orderBy} LIMIT ?`,
    ...params,
    prefix,
    limit
  );
  return [...custom.map(customRowToFood), ...usda.map(usdaRowToFood)];
}

export async function getFoodByRef(ref: string): Promise<FoodItem | null> {
  const sep = ref.indexOf(':');
  const kind = ref.slice(0, sep);
  const key = ref.slice(sep + 1);

  if (kind === 'usda') {
    const r = await getFoodsDb().getFirstAsync<FoodRow>(
      'SELECT * FROM foods WHERE id = ?',
      Number(key)
    );
    return r ? usdaRowToFood(r) : null;
  }
  if (kind === 'custom') {
    const r = await getUserDb().getFirstAsync<FoodRow>(
      'SELECT * FROM custom_foods WHERE id = ?',
      Number(key)
    );
    return r ? customRowToFood(r) : null;
  }
  if (kind === 'barcode') {
    const r = await getUserDb().getFirstAsync<FoodRow & { barcode: string }>(
      'SELECT rowid AS id, * FROM barcode_cache WHERE barcode = ?',
      key
    );
    if (!r) return null;
    return {
      ref,
      source: 'barcode',
      name: r.name,
      brand: r.brand ?? null,
      category: null,
      per100: rowMacros(r),
      portions: parsePortions(r.portions_json),
    };
  }
  return null;
}

export type CustomFoodInput = {
  name: string;
  brand?: string | null;
  per100: Macros;
  portions?: Portion[];
  barcode?: string | null;
};

export async function createCustomFood(input: CustomFoodInput): Promise<FoodItem> {
  const res = await getUserDb().runAsync(
    `INSERT INTO custom_foods
       (name, name_norm, brand, kcal, protein, carbs, fat, fiber, sugar, sodium_mg, portions_json, barcode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name.trim(),
    normName(input.name),
    input.brand?.trim() || null,
    input.per100.kcal,
    input.per100.protein,
    input.per100.carbs,
    input.per100.fat,
    input.per100.fiber,
    input.per100.sugar,
    input.per100.sodiumMg,
    JSON.stringify(input.portions ?? []),
    input.barcode ?? null,
    new Date().toISOString()
  );
  const food = await getFoodByRef(`custom:${res.lastInsertRowId}`);
  if (!food) throw new Error('Failed to create custom food');
  return food;
}

/** Custom food previously created for a barcode OFF didn't know. */
export async function getCustomFoodByBarcode(barcode: string): Promise<FoodItem | null> {
  const r = await getUserDb().getFirstAsync<FoodRow>(
    'SELECT * FROM custom_foods WHERE barcode = ? ORDER BY id DESC',
    barcode
  );
  return r ? customRowToFood(r) : null;
}

/** Distinct recently-logged foods, most recent first. */
export async function recentFoods(limit = 20): Promise<FoodItem[]> {
  const rows = await getUserDb().getAllAsync<{ food_ref: string }>(
    `SELECT food_ref, MAX(ts) AS last_ts FROM log_entries
     WHERE food_ref IS NOT NULL
     GROUP BY food_ref ORDER BY last_ts DESC LIMIT ?`,
    limit
  );
  const foods: FoodItem[] = [];
  for (const row of rows) {
    const f = await getFoodByRef(row.food_ref);
    if (f) foods.push(f);
  }
  return foods;
}

export async function getFoodDbInfo(): Promise<{ count: number; sources: string }> {
  const count = await getFoodsDb().getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM foods');
  const sources = await getFoodsDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'sources'"
  );
  return { count: count?.c ?? 0, sources: sources?.value ?? 'unknown' };
}
