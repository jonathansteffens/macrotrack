import { getFoodsDb, getUserDb } from './db';
import { normName } from './norm';
import { getRecipe, recipeToFood } from './recipes';
import type { FoodItem, Macros, Portion } from './types';

export { normName };

type FoodRow = {
  id: number;
  name: string;
  /** Friendly display name (foods table only; NULL for most rows, absent on
   *  custom_foods / barcode_cache which have no such column). */
  display_name?: string | null;
  brand?: string | null;
  category?: string | null;
  kcal: number;
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
  portions_json: string;
  unit?: string | null;
  data_type?: string | null;
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
    satFat: r.sat_fat ?? null,
    cholesterolMg: r.cholesterol_mg ?? null,
    calciumMg: r.calcium_mg ?? null,
    ironMg: r.iron_mg ?? null,
    potassiumMg: r.potassium_mg ?? null,
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
    displayName: r.display_name ?? null,
    brand: null,
    category: r.category ?? null,
    per100: rowMacros(r),
    portions: parsePortions(r.portions_json),
    dataType: r.data_type ?? null,
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
    unit: r.unit === 'ml' ? 'ml' : 'g',
    portions: parsePortions(r.portions_json),
  };
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Function words that hurt matching (e.g. "with" substring-matches "without"). */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

/**
 * Whether the bundled foods table carries the display_name_norm column. It is
 * guaranteed present in the shipped DB, but an older cached copy (imported
 * before the column existed) may not — so both the manual-search display
 * matching and the resolver's display stage check this once (cached) and
 * degrade gracefully rather than throwing "no such column". The column set of
 * a bundled read-only DB can't change within a session, so caching is safe.
 */
let displayNormChecked = false;
let hasDisplayNorm = false;
async function foodsHasDisplayNorm(): Promise<boolean> {
  if (displayNormChecked) return hasDisplayNorm;
  try {
    const cols = await getFoodsDb().getAllAsync<{ name: string }>("PRAGMA table_info('foods')");
    hasDisplayNorm = cols.some((c) => c.name === 'display_name_norm');
  } catch {
    hasDisplayNorm = false;
  }
  displayNormChecked = true;
  return hasDisplayNorm;
}

/**
 * Where a USDA search may draw from. 'common' is the curated manual-search
 * subset (foods.common >= 1) — used when a person types a food, so results
 * aren't buried under hundreds of near-duplicate reference entries. 'all' is
 * the full table, used by the AI resolver so the model's search terms can
 * resolve against everything. 'display' is an internal capability for the
 * resolver's second-stage fallback: the SAME tokenized match/ranking as 'all'
 * but run against the plain-language display_name_norm ("mac and cheese")
 * instead of the technical name_norm — see resolveItem in ai/resolver.ts. See
 * the `common` / `display_name` columns in tools/build-food-db.mjs.
 */
export type SearchScope = 'common' | 'all' | 'display';

/**
 * Tokenized search over custom foods (first) and the bundled USDA table.
 * Stopwords are dropped, and every remaining token must start a word in the
 * normalized name (word-boundary prefix match). Results whose name starts
 * with the first token rank first, then shorter names. Manual typing uses the
 * 'common' subset (and also matches plain-language display names); if that
 * finds nothing, it falls back to the full table so obscure foods stay
 * reachable.
 */
export async function searchFoods(
  query: string,
  limit = 50,
  scope: SearchScope = 'common'
): Promise<FoodItem[]> {
  const all = normName(query).split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (tokens.length === 0) return [];

  const params = tokens.map((t) => `% ${escapeLike(t)}%`);
  const prefix = `${escapeLike(tokens[0])}%`;
  // Rank: exact whole-word match on the first token first (so "egg" beats
  // "eggplant", "salmon" beats "salmonberries"), then names starting with it.
  const wholeWord = `CASE WHEN (' ' || name_norm || ' ') LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END`;
  const wholeWordParam = `% ${escapeLike(tokens[0])} %`;
  const wordStart = `CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END`;
  // Word count of the name — a "plainness" tiebreak so the everyday staple
  // ("Rice, cooked") outranks a wordier variant before falling back to raw
  // string length. (No placeholder; it references name_norm directly.)
  const wordCount = `(LENGTH(name_norm) - LENGTH(REPLACE(name_norm, ' ', '')) + 1)`;

  // ---- 'display' scope: the AI resolver's strict-superset second stage ----
  // Identical WHERE/ranking shape to 'all', but every name_norm reference is
  // swapped for display_name_norm, guarded to rows that actually have one.
  // Custom foods are intentionally skipped — stage 1 ('all') already searched
  // them and they carry no display name. Read defensively: an older bundled DB
  // may lack the column, in which case return [] rather than throwing.
  if (scope === 'display') {
    if (!(await foodsHasDisplayNorm())) return [];
    const dWhere = tokens
      .map(() => "(' ' || display_name_norm) LIKE ? ESCAPE '\\'")
      .join(' AND ');
    const dWholeWord = `CASE WHEN (' ' || display_name_norm || ' ') LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END`;
    const dWordStart = `CASE WHEN display_name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END`;
    const rows = await getFoodsDb().getAllAsync<FoodRow>(
      `SELECT * FROM foods WHERE ${dWhere} AND display_name_norm IS NOT NULL
       ORDER BY ${dWholeWord}, ${dWordStart}, LENGTH(display_name_norm) LIMIT ?`,
      ...params,
      wholeWordParam,
      prefix,
      limit
    );
    return rows.map(usdaRowToFood);
  }

  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');

  const custom = await getUserDb().getAllAsync<FoodRow>(
    `SELECT * FROM custom_foods WHERE ${where}
     ORDER BY ${wholeWord}, ${wordStart}, LENGTH(name_norm) LIMIT 10`,
    ...params,
    wholeWordParam,
    prefix
  );

  // Manual search matches the plain-language display_name_norm as well as the
  // technical name_norm — needs the column, so probe once and fall back to the
  // original name-only ranking on an old DB. ('all' never touches this.)
  const displayReady = scope === 'common' ? await foodsHasDisplayNorm() : false;

  const queryUsda = (commonOnly: boolean) => {
    if (!commonOnly) {
      // Resolver ('all'): whole-word match on the first token outranks
      // substring matches (so "chick fil a chicken sandwich" beats "chicken
      // fillet sandwich" — 'chick' as a word, not inside 'chicken'), matching
      // the manual-search semantics. Mirrored in tools/eval/run-eval.mjs and
      // tools/chat/playground.mjs so model terms resolve consistently.
      // CANONICAL — kept exactly as-is; the display bridge never touches this.
      return getFoodsDb().getAllAsync<FoodRow>(
        `SELECT * FROM foods WHERE ${where}
         ORDER BY ${wholeWord}, ${wordStart}, LENGTH(name_norm) LIMIT ?`,
        ...params,
        wholeWordParam,
        prefix,
        limit
      );
    }
    if (!displayReady) {
      // Old bundled DB without display_name_norm: original name-only ranking.
      // Whole-word first, then head-noun prefix, then the primary generics
      // (common = 2) above everyday foods (= 1), then plainer, then shortest.
      return getFoodsDb().getAllAsync<FoodRow>(
        `SELECT * FROM foods WHERE ${where} AND common >= 1
         ORDER BY ${wholeWord}, ${wordStart}, common DESC, ${wordCount}, LENGTH(name_norm) LIMIT ?`,
        ...params,
        wholeWordParam,
        prefix,
        limit
      );
    }
    // Display-aware common subset (Part 2 of the common-name bridge): a row
    // qualifies if ALL tokens hit name_norm OR ALL hit display_name_norm, and
    // every ranking tier takes MIN(name, display) so the friendlier field can
    // only ever help a row's rank, never hurt it. Tiers preserved in spirit:
    // whole-word, word-start, common DESC, word-count (plainness), raw length.
    // COALESCE guards the length/word-count of rows with a NULL display name.
    const whereDisp = tokens
      .map(() => "(' ' || display_name_norm) LIKE ? ESCAPE '\\'")
      .join(' AND ');
    const wholeWordDisp = `CASE WHEN (' ' || display_name_norm || ' ') LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END`;
    const wordStartDisp = `CASE WHEN display_name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END`;
    const wordCountDisp = `(LENGTH(display_name_norm) - LENGTH(REPLACE(display_name_norm, ' ', '')) + 1)`;
    return getFoodsDb().getAllAsync<FoodRow>(
      `SELECT * FROM foods
       WHERE ( (${where})
               OR (${whereDisp} AND display_name_norm IS NOT NULL) ) AND common >= 1
       ORDER BY
         MIN(${wholeWord}, ${wholeWordDisp}),
         MIN(${wordStart}, ${wordStartDisp}),
         common DESC,
         MIN(${wordCount}, COALESCE(${wordCountDisp}, 9999)),
         MIN(LENGTH(name_norm), COALESCE(LENGTH(display_name_norm), 9999))
       LIMIT ?`,
      ...params, // WHERE — name_norm tokens
      ...params, // WHERE — display_name_norm tokens
      wholeWordParam, // ORDER — whole-word (name)
      wholeWordParam, // ORDER — whole-word (display)
      prefix, // ORDER — word-start (name)
      prefix, // ORDER — word-start (display)
      limit
    );
  };
  let usda = await queryUsda(scope === 'common');
  // Nothing in the curated subset? Fall back to the full table so a manual
  // search for something obscure still finds it.
  if (usda.length === 0 && scope === 'common') usda = await queryUsda(false);

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
      unit: r.unit === 'ml' ? 'ml' : 'g',
      portions: parsePortions(r.portions_json),
    };
  }
  if (kind === 'recipe') {
    const recipe = await getRecipe(Number(key));
    return recipe ? recipeToFood(recipe) : null;
  }
  return null;
}

export type CustomFoodInput = {
  name: string;
  brand?: string | null;
  per100: Macros;
  portions?: Portion[];
  barcode?: string | null;
  unit?: 'g' | 'ml';
};

export async function createCustomFood(input: CustomFoodInput): Promise<FoodItem> {
  const res = await getUserDb().runAsync(
    `INSERT INTO custom_foods
       (name, name_norm, brand, kcal, protein, carbs, fat, fiber, sugar, sodium_mg,
        sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg,
        portions_json, barcode, unit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.per100.satFat,
    input.per100.cholesterolMg,
    input.per100.calciumMg,
    input.per100.ironMg,
    input.per100.potassiumMg,
    JSON.stringify(input.portions ?? []),
    input.barcode ?? null,
    input.unit ?? 'g',
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
