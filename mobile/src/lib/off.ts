import { getUserDb } from './db';
import { getFoodByRef } from './foods';
import type { FoodItem, Portion } from './types';

/**
 * Open Food Facts barcode lookup with a local cache. Cached products are
 * served without a network call (they also keep previously-logged barcode
 * entries resolvable offline).
 */

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = 'product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit';
const USER_AGENT = 'MacroTrack/0.1 (personal macro tracker)';
const CACHE_TTL_DAYS = 30;

export type BarcodeLookup =
  | { status: 'found'; food: FoodItem }
  | { status: 'not_found' }
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
    if (!resp.ok) return { status: 'error', message: `Open Food Facts returned ${resp.status}` };
    json = await resp.json();
  } catch {
    return { status: 'error', message: 'Network error — check your connection and try again.' };
  }

  if (json?.status !== 1 || !json.product) return { status: 'not_found' };
  const p = json.product;
  const n: OffNutriments = p.nutriments ?? {};

  // Energy: prefer kcal directly, fall back to kJ
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null) {
    const kj = num(n['energy_100g']);
    if (kj != null) kcal = kj / 4.184;
  }
  if (kcal == null) return { status: 'not_found' }; // unusable without energy

  // Sodium comes back in grams; salt fallback (salt ≈ 2.5 × sodium)
  let sodiumMg: number | null = null;
  const sodiumG = num(n['sodium_100g']);
  const saltG = num(n['salt_100g']);
  if (sodiumG != null) sodiumMg = sodiumG * 1000;
  else if (saltG != null) sodiumMg = (saltG / 2.5) * 1000;

  const portions: Portion[] = [];
  const servingQty = num(p.serving_quantity);
  const servingUnit = (p.serving_quantity_unit ?? 'g') as string;
  if (servingQty != null && servingQty > 0 && (servingUnit === 'g' || servingUnit === 'ml')) {
    portions.push({
      label: `1 serving${p.serving_size ? ` (${p.serving_size})` : ''}`,
      grams: servingQty,
    });
  }

  const name = (p.product_name ?? '').trim();
  if (!name) return { status: 'not_found' };

  await getUserDb().runAsync(
    `INSERT OR REPLACE INTO barcode_cache
       (barcode, name, brand, kcal, protein, carbs, fat, fiber, sugar, sodium_mg, portions_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    barcode,
    name,
    (p.brands ?? '').split(',')[0].trim() || null,
    kcal,
    num(n['proteins_100g']) ?? 0,
    num(n['carbohydrates_100g']) ?? 0,
    num(n['fat_100g']) ?? 0,
    num(n['fiber_100g']),
    num(n['sugars_100g']),
    sodiumMg,
    JSON.stringify(portions),
    new Date().toISOString()
  );

  const food = await getFoodByRef(`barcode:${barcode}`);
  return food ? { status: 'found', food } : { status: 'error', message: 'Cache write failed' };
}

async function getCached(barcode: string): Promise<FoodItem | null> {
  const row = await getUserDb().getFirstAsync<{ fetched_at: string }>(
    'SELECT fetched_at FROM barcode_cache WHERE barcode = ?',
    barcode
  );
  if (!row) return null;
  const ageDays = (Date.now() - Date.parse(row.fetched_at)) / 86_400_000;
  // Stale entries are still used if the refresh fails — data > no data.
  if (ageDays > CACHE_TTL_DAYS) return null;
  return getFoodByRef(`barcode:${barcode}`);
}
