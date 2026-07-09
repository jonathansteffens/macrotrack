import { getUserDb } from './db';
import { getFoodByRef } from './foods';
import type { FoodItem, Portion } from './types';

/**
 * Open Food Facts barcode lookup with a local cache. Cached products are
 * served without a network call (they also keep previously-logged barcode
 * entries resolvable offline).
 */

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS =
  'product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per';
const USER_AGENT = 'MacroTrack/0.1 (personal macro tracker)';
const CACHE_TTL_DAYS = 30;

/**
 * What OFF knew about a product it couldn't fully resolve (missing usable
 * energy) — enough to pre-fill the custom-food form so the user isn't retyping
 * everything from the label.
 */
export type PartialProduct = {
  name: string;
  brand: string | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
};

export type BarcodeLookup =
  | { status: 'found'; food: FoodItem }
  | { status: 'not_found'; partial?: PartialProduct }
  | { status: 'error'; message: string };

type OffNutriments = Record<string, number | string | undefined>;

function num(v: number | string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export async function lookupBarcode(barcode: string): Promise<BarcodeLookup> {
  const cached = await getCached(barcode);
  if (cached) return { status: 'found', food: cached };

  // When the refresh fails, fall back to any cached copy — even one past its
  // TTL — before surfacing an error; only error when there's no cache at all.
  const failWith = async (message: string): Promise<BarcodeLookup> => {
    const stale = await getCached(barcode, { allowStale: true });
    return stale ? { status: 'found', food: stale } : { status: 'error', message };
  };

  let json: any;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(`${OFF_URL}${encodeURIComponent(barcode)}.json?fields=${OFF_FIELDS}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 404) return { status: 'not_found' };
    if (!resp.ok) return failWith(`Open Food Facts returned ${resp.status}`);
    json = await resp.json();
  } catch {
    return failWith('Network error — check your connection and try again.');
  }

  if (json?.status !== 1 || !json.product) return { status: 'not_found' };
  const p = json.product;
  const n: OffNutriments = p.nutriments ?? {};
  const name = (p.product_name ?? '').trim();
  const brand = (p.brands ?? '').split(',')[0].trim() || null;

  // Energy: prefer kcal directly, fall back to kJ
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null) {
    const kj = num(n['energy_100g']);
    if (kj != null) kcal = kj / 4.184;
  }
  if (kcal == null || !name) {
    // OFF knows this product but can't give a usable per-100 energy (or name).
    // Hand back the macros it did have so custom-food can pre-fill them.
    return {
      status: 'not_found',
      partial: name
        ? {
            name,
            brand,
            protein: num(n['proteins_100g']),
            carbs: num(n['carbohydrates_100g']),
            fat: num(n['fat_100g']),
          }
        : undefined,
    };
  }

  // Sodium comes back in grams; salt fallback (salt ≈ 2.5 × sodium)
  let sodiumMg: number | null = null;
  const sodiumG = num(n['sodium_100g']);
  const saltG = num(n['salt_100g']);
  if (sodiumG != null) sodiumMg = sodiumG * 1000;
  else if (saltG != null) sodiumMg = (saltG / 2.5) * 1000;

  // Saturated fat is reported in grams; cholesterol/minerals in grams → mg.
  const satFat = num(n['saturated-fat_100g']);
  const gToMg = (g: number | null) => (g != null ? g * 1000 : null);
  const cholesterolMg = gToMg(num(n['cholesterol_100g']));
  const calciumMg = gToMg(num(n['calcium_100g']));
  const ironMg = gToMg(num(n['iron_100g']));
  const potassiumMg = gToMg(num(n['potassium_100g']));

  const portions: Portion[] = [];
  const servingQty = num(p.serving_quantity);
  const servingUnit = (p.serving_quantity_unit ?? 'g') as string;
  if (servingQty != null && servingQty > 0 && (servingUnit === 'g' || servingUnit === 'ml')) {
    portions.push({
      label: `1 serving${p.serving_size ? ` (${p.serving_size})` : ''}`,
      grams: servingQty,
    });
  }

  // Liquids: OFF marks these with a 'ml' serving unit or per-100ml nutrition.
  const unit: 'g' | 'ml' =
    servingUnit === 'ml' || p.nutrition_data_per === '100ml' ? 'ml' : 'g';

  await getUserDb().runAsync(
    `INSERT OR REPLACE INTO barcode_cache
       (barcode, name, brand, kcal, protein, carbs, fat, fiber, sugar, sodium_mg,
        sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg,
        portions_json, unit, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    barcode,
    name,
    brand,
    kcal,
    num(n['proteins_100g']) ?? 0,
    num(n['carbohydrates_100g']) ?? 0,
    num(n['fat_100g']) ?? 0,
    num(n['fiber_100g']),
    num(n['sugars_100g']),
    sodiumMg,
    satFat,
    cholesterolMg,
    calciumMg,
    ironMg,
    potassiumMg,
    JSON.stringify(portions),
    unit,
    new Date().toISOString()
  );

  const food = await getFoodByRef(`barcode:${barcode}`);
  return food ? { status: 'found', food } : { status: 'error', message: 'Cache write failed' };
}

async function getCached(
  barcode: string,
  { allowStale = false }: { allowStale?: boolean } = {}
): Promise<FoodItem | null> {
  const row = await getUserDb().getFirstAsync<{ fetched_at: string }>(
    'SELECT fetched_at FROM barcode_cache WHERE barcode = ?',
    barcode
  );
  if (!row) return null;
  const ageDays = (Date.now() - Date.parse(row.fetched_at)) / 86_400_000;
  // Fresh entries serve without a network call. Stale entries are still used
  // when the refresh fails (allowStale) — data > no data. See lookupBarcode.
  if (!allowStale && ageDays > CACHE_TTL_DAYS) return null;
  return getFoodByRef(`barcode:${barcode}`);
}
