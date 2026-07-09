import { getFoodsDb } from '../db';
import { normName, searchFoods } from '../foods';
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
  // Load the corroboration token set once so the sync seedGrams can read it.
  await loadCommonBrandTokens();
  return Promise.all(claim.items.map(resolveItem));
}

const COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, dozen: 12,
};

// ---- Branded corroboration guard — keep IN SYNC across resolver.ts,
//   tools/eval/run-eval.mjs, tools/chat/playground.mjs,
//   tools/eval/adversarial/run.mjs ----
// A single generic search token can whole-word match a branded row by accident
// ("oreo" → "Dairy Queen Royal Oreo Blizzard"); branded serving-scaling would
// then multiply the model's count by that row's ~350 g serving ("4 oreos" →
// 1400 g / 4200 kcal). So branded serving-scaling applies ONLY when the match
// is CORROBORATED by the model's own words: it named the row's brand/chain, OR
// it named every one of the row's distinctive (product-identity) tokens.
// COMMON_BRAND_TOKENS = tokens in ≥ COMMON_DF_MIN branded name_norms — chain
// names (dairy, queen, burger, king, …) plus generic food words (sandwich,
// cheese, …); everything rarer is a distinctive token (baconator, whopper,
// blizzard, big, mac, …). Derived once from the bundled foods.db.
const COMMON_DF_MIN = 20;
const CORROB_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);
function corrTokens(s: string): string[] {
  return (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t.length >= 3 && !CORROB_STOPWORDS.has(t));
}
let commonBrandTokens: Set<string> | null = null;
async function loadCommonBrandTokens(): Promise<Set<string>> {
  if (commonBrandTokens) return commonBrandTokens;
  const rows = await getFoodsDb().getAllAsync<{ name_norm: string }>(
    "SELECT name_norm FROM foods WHERE data_type = 'branded'"
  );
  const df = new Map<string, number>();
  for (const r of rows) for (const t of new Set(corrTokens(r.name_norm))) df.set(t, (df.get(t) ?? 0) + 1);
  const set = new Set<string>();
  for (const [t, n] of df) if (n >= COMMON_DF_MIN) set.add(t);
  commonBrandTokens = set;
  return set;
}
function brandedCorroborated(item: ClaimItem, rowNameNorm: string): boolean {
  // Not yet loaded (shouldn't happen — resolveClaim awaits it) → preserve the
  // legacy branded-snap behavior rather than mis-rejecting a real match.
  if (!commonBrandTokens) return true;
  const modelToks = new Set([item.name, ...(item.db_search_terms || [])].flatMap(corrTokens));
  const rowToks = [...new Set(corrTokens(rowNameNorm))];
  const distinctive = rowToks.filter((t) => !commonBrandTokens!.has(t));
  const common = rowToks.filter((t) => commonBrandTokens!.has(t));
  const namedBrand = common.length > 0 && common.every((t) => modelToks.has(t));
  const namedProduct = distinctive.length > 0 && distinctive.every((t) => modelToks.has(t));
  return namedBrand || namedProduct;
}

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
    // Stage 1 — 'all': the model's search terms resolve against the full
    // database (technical name_norm), not just the curated manual-search
    // subset, for the best chance of a canonical match.
    candidates = await searchFoods(term, 6, 'all');
    if (candidates.length > 0) break;
  }
  // Stage 2 (STRICT SUPERSET) — only when stage 1 found NOTHING for every term
  // do we retry the same terms against the plain-language display names
  // (display_name_norm). Because it fires exclusively on the zero-candidate
  // path, no resolution stage 1 already produced can change: this can only
  // rescue a claim that would otherwise fall back to the model's own estimate
  // (e.g. a friendly "mac and cheese" that missed the technical names). Kept in
  // sync with tools/eval/run-eval.mjs, tools/chat/playground.mjs, and
  // tools/eval/adversarial/run.mjs.
  if (candidates.length === 0) {
    for (const term of terms) {
      candidates = await searchFoods(term, 6, 'display');
      if (candidates.length > 0) break;
    }
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
  // Branded serving-scaling only when the model's words corroborate the match
  // (see brandedCorroborated) — an uncorroborated branded row is a coincidental
  // token collision, so keep the model's own grams instead of snapping.
  const corroborated =
    match?.dataType === 'branded' && brandedCorroborated(item, normName(match.name));
  const brandedServing = corroborated ? pickServing(item, match) : undefined;
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
