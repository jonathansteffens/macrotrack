import type { Macros } from './types';
import type { Recipe, RecipeItem } from './recipes';

/**
 * Recipe sharing as a QR payload: `MTRCP1:` + compact JSON. Small enough to
 * scan reliably (capped ~1800 chars — QR stays under version ~30 at EC M).
 *
 * What travels: name, servings, and per-ingredient name + grams + big-four
 * per-100g snapshot. Micronutrients are dropped for size — a shared recipe's
 * job is calories and macros. `usda:` food refs travel too (both phones bundle
 * the same database, so the link survives); device-local refs (custom:,
 * barcode:, recipe:) don't.
 */

const PREFIX = 'MTRCP1:';
const MAX_CHARS = 1800;

const round1 = (v: number | null | undefined): number =>
  v == null ? 0 : Math.round(v * 10) / 10;

type WireItem = [name: string, grams: number, kcal: number, p: number, c: number, f: number, ref: string | null];
type WirePayload = { v: 1; n: string; s: number; i: WireItem[] };

/** Encode for a QR. Null when the recipe is too large to share this way. */
export function encodeRecipeShare(recipe: Recipe): string | null {
  const payload: WirePayload = {
    v: 1,
    n: recipe.name,
    s: recipe.servings,
    i: recipe.items.map((it) => [
      it.foodName,
      Math.round(it.grams),
      round1(it.per100.kcal),
      round1(it.per100.protein),
      round1(it.per100.carbs),
      round1(it.per100.fat),
      it.foodRef?.startsWith('usda:') ? it.foodRef : null,
    ]),
  };
  const encoded = PREFIX + JSON.stringify(payload);
  return encoded.length <= MAX_CHARS ? encoded : null;
}

/** True when scanned data looks like a shared recipe. */
export function isRecipeShare(data: string): boolean {
  return data.startsWith(PREFIX);
}

/**
 * Decode scanned data back into savable recipe parts. Null on anything
 * malformed — scanned bytes are untrusted input, so every field is checked
 * and clamped rather than trusted.
 */
export function decodeRecipeShare(
  data: string
): { name: string; servings: number; items: RecipeItem[] } | null {
  if (!isRecipeShare(data)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<WirePayload>;
  if (p.v !== 1 || typeof p.n !== 'string' || !Array.isArray(p.i)) return null;
  const servings = typeof p.s === 'number' && p.s > 0 ? Math.min(p.s, 100) : 1;

  const items: RecipeItem[] = [];
  for (const entry of p.i.slice(0, 40)) {
    if (!Array.isArray(entry)) return null;
    const [name, grams, kcal, protein, carbs, fat, ref] = entry;
    if (typeof name !== 'string' || !name.trim()) return null;
    const num = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    const per100: Macros = {
      kcal: num(kcal),
      protein: num(protein),
      carbs: num(carbs),
      fat: num(fat),
      fiber: null,
      sugar: null,
      sodiumMg: null,
      satFat: null,
      cholesterolMg: null,
      calciumMg: null,
      ironMg: null,
      potassiumMg: null,
    };
    items.push({
      foodName: name.slice(0, 120),
      foodRef: typeof ref === 'string' && ref.startsWith('usda:') ? ref : null,
      grams: Math.min(Math.max(num(grams), 1), 20000),
      per100,
    });
  }
  if (items.length === 0) return null;
  return { name: p.n.slice(0, 80).trim() || 'Shared recipe', servings, items };
}
