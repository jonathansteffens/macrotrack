import { searchFoods } from '../foods';
import { scaleMacros } from '../macros';
import type { FoodItem, Macros } from '../types';
import type { ClaimItem, FoodClaim } from './types';

/**
 * The resolver is where AI claims meet the food database: each claimed item
 * is matched against bundled USDA + custom foods so final nutrition numbers
 * come from canonical data. The model's own per-100g estimate is used only
 * when nothing matches (flagged as `ai_estimate` on the log entry).
 */

export type ResolvedItem = {
  claim: ClaimItem;
  /** Chosen DB match; null → fall back to the model's estimate */
  match: FoodItem | null;
  /** Other candidates the user can switch to */
  alternatives: FoodItem[];
  /** Editable amount, seeded from the claim */
  grams: number;
};

export async function resolveClaim(claim: FoodClaim): Promise<ResolvedItem[]> {
  return Promise.all(claim.items.map(resolveItem));
}

const COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, dozen: 12,
};

/** Explicit count in an item name ("2 whopper", "three tacos"), if any. */
function countInName(name: string): number | null {
  const m = /^(\d{1,2})\s+/.exec(name.trim());
  if (m) return Math.min(24, parseInt(m[1], 10)) || null;
  const w = name.trim().toLowerCase().split(/\s+/)[0];
  return COUNT_WORDS[w] ?? null;
}

async function resolveItem(item: ClaimItem): Promise<ResolvedItem> {
  // The model sometimes bakes an explicit count into the item name
  // ("2 whopper") — search with the count stripped too, so it still matches.
  const stripped = item.name.replace(/^(\d{1,2}|[a-z]+)\s+/i, '');
  const terms = [...item.db_search_terms, item.name];
  if (countInName(item.name) && stripped) terms.push(stripped);
  let candidates: FoodItem[] = [];
  for (const term of terms) {
    // 'all' — the model's search terms resolve against the full database, not
    // just the curated manual-search subset, for the best chance of a match.
    candidates = await searchFoods(term, 6, 'all');
    if (candidates.length > 0) break;
  }
  const match = candidates[0] ?? null;
  return {
    claim: item,
    match,
    alternatives: candidates.slice(0, 5),
    grams: seedGrams(item, match),
  };
}

/**
 * Seed the editable amount from the claim. Branded restaurant items are
 * fixed-format products whose DB row carries the real serving weight, and the
 * model reliably identifies WHICH item but guesses generic weights (a Whopper
 * claimed at ~113 g vs the real 270 g would halve its calories) — so use whole
 * servings: an explicit count in the item name wins, a plural name snaps the
 * model's grams to the nearest serving count, and otherwise it's one item
 * (small models over-guess single-item grams; trusting the grams here doubled
 * a single donut). Non-branded items keep the model's grams — users often
 * state exact weights for generic foods.
 *
 * v2: when the model reports a whole-unit `count`, the app does the multiply
 * (it copies the count; code multiplies) — count × per-unit serving. The
 * per-unit serving is the branded DB serving when there's a branded match,
 * else the model's `unit_grams`, else the model's total split by its own count.
 */
function seedGrams(item: ClaimItem, match: FoodItem | null): number {
  const brandedServing = match?.dataType === 'branded' ? pickServing(item, match) : undefined;
  if (typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0) {
    // Stopgap for the "fake branded SKU" emission {name:"2 big mac", count:1}:
    // the model bakes the real count into the NAME but leaves count stuck at 1.
    // When count is exactly 1, trust the larger of count and any count in the
    // name; a genuine count > 1 is left untouched. (mirrors run-eval.mjs,
    // playground.mjs seedGrams — keep the three in sync.)
    const effCount = item.count === 1 ? Math.max(item.count, countInName(item.name) ?? 1) : item.count;
    const count = Math.min(24, Math.max(0.25, effCount));
    const serving =
      brandedServing && brandedServing > 0
        ? brandedServing
        : item.unit_grams && item.unit_grams > 0
          ? item.unit_grams
          : item.grams / item.count;
    return Math.round(count * serving);
  }
  // No count → existing branded-snap behavior exactly.
  const serving = brandedServing;
  if (!serving || serving <= 0) return Math.round(item.grams);
  const explicit = countInName(item.name);
  const plural = /s$/i.test(item.name.trim());
  const count = explicit ?? (plural ? Math.min(24, Math.max(1, Math.round(item.grams / serving))) : 1);
  return Math.round(count * serving);
}

/**
 * Some DB rows carry several named servings (FNDDS packs "Mac Jr" 135 g /
 * "Big Mac" 205 g / "Grand Mac" 315 g into one row's portions). Prefer the
 * portion whose label mentions the claimed item; tie-break by closeness to the
 * model's grams.
 */
function pickServing(item: ClaimItem, match: FoodItem): number | undefined {
  const portions = match.portions.filter((p) => p.grams > 0);
  if (portions.length <= 1) return portions[0]?.grams;
  const nameTokens = item.name.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const score = (label: string) => {
    const l = label.toLowerCase();
    return nameTokens.filter((t) => l.includes(t)).length;
  };
  return portions.sort(
    (a, b) => score(b.label) - score(a.label) || Math.abs(a.grams - item.grams) - Math.abs(b.grams - item.grams)
  )[0].grams;
}

/** Macros for the item as currently resolved (DB match or model fallback). */
export function resolvedMacros(item: ResolvedItem): Macros {
  if (item.match) return scaleMacros(item.match.per100, item.grams);
  const f = item.grams / 100;
  return {
    kcal: item.claim.est_per100.kcal * f,
    protein: item.claim.est_per100.protein * f,
    carbs: item.claim.est_per100.carbs * f,
    fat: item.claim.est_per100.fat * f,
    // The model only estimates the four core macros; the rest are unknown
    // unless the item resolves to a database food.
    fiber: null,
    sugar: null,
    sodiumMg: null,
    satFat: null,
    cholesterolMg: null,
    calciumMg: null,
    ironMg: null,
    potassiumMg: null,
  };
}

export function displayName(item: ResolvedItem): string {
  if (item.match) return item.match.displayName ?? item.match.name;
  return item.claim.name;
}
