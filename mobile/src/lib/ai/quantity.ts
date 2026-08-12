/**
 * Deterministic quantity grammar — the app-side twin of tools/parse/quantity.mjs.
 *
 * KEEP IN SYNC with tools/parse/quantity.mjs (and its tests in
 * tools/parse/quantity.test.mjs / quantity.test.ts here). The tools copy is what
 * the offline eval harnesses use; this one is what ships. They must agree or the
 * gate stops predicting app behaviour.
 *
 * WHY. The estimator does five jobs: segment the text, name each food, parse how
 * much, infer unstated portions, and estimate macros for foods the DB lacks.
 * Three need world knowledge and are a good use of a model. Parsing "how much"
 * is arithmetic and idiom lookup, where a grammar is exact and a sampled model
 * is probabilistic. Every quantity failure in the v9/v10 adversarial gate was a
 * parse error, not a knowledge error:
 *
 *   "half a dozen bagels"              -> count 12   (the idiom is 6)
 *   "a half pound turkey burger patty" -> count 0.5  (a weight read as a count)
 *   "20 chicken nuggets"               -> count null (count dropped entirely)
 *   "a pound of ground beef"           -> 182 g      (1 lb is 454 g, exactly)
 *
 * Schema v2 already moved the MULTIPLICATION into code ("the model copies
 * counts, code multiplies"). This is the same move one step earlier: take the
 * PARSE too, and leave the model the jobs only it can do.
 *
 * Used as a CONFIDENT OVERRIDE: it reports what it is sure of and returns null
 * otherwise, so tangled input still falls through to the model. A wrong parse is
 * worse than no parse — it replaces a decent estimate with a confident wrong one.
 */

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, sixteen: 16,
  twenty: 20, dozen: 12,
};
const NUM_WORD_RE = Object.keys(NUM_WORDS).join('|');

/** Weight units → grams. Exact conversions; this is the whole point. */
const WEIGHT_G: Record<string, number> = {
  g: 1, gram: 1, grams: 1, gm: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
};
const WEIGHT_RE = Object.keys(WEIGHT_G).join('|');

const FRACTIONS: Record<string, number> = { half: 0.5, quarter: 0.25, third: 0.33 };

// Drink nouns and drink CONTAINERS, both read from the user's own words. This
// is the fallback liquid signal when the claim did not resolve to a DB row: an
// on-device decode of "A 12 oz can of coke" produced a garbled claim name that
// matched nothing, and with no match the fluid-vs-weight question had no
// answer, so a wrong identity also cost the grams. The user's wording cannot be
// poisoned by the model's output, which makes it the right place to look.
//
// Both are required. "12 oz bag of coffee" is coffee BEANS (weight) — 'bag' is
// not a drink container, and 'pack'/'box' are excluded for the same reason.
const DRINK_NOUN_RE = /\b(?:coke|cola|soda|pop|sprite|pepsi|dr\.?\s*pepper|mountain\s*dew|root\s*beer|beer|ale|lager|cider|wine|juice|water|milk|coffee|tea|lemonade|gatorade|powerade|energy\s*drink|kombucha|seltzer|tonic|smoothie|shake|latte)\b/i;
const DRINK_CONTAINER_RE = /\b(?:cans?|bottles?|glass(?:es)?|mugs?|jugs?|cartons?|pints?)\b/i;

/** Container words that make a bare "oz" ambiguous between weight and fluid. */
const CONTAINER_RE = /\b(?:cans?|bottles?|glass(?:es)?|mugs?|pints?|cartons?|jugs?|boxes?|packs?)\b/i;

/**
 * Volume measures — and "fl oz", which must never reach the weight table where a
 * bare "oz" means 28.35 g. Grams per unit volume depends on the food (3 cups of
 * popcorn ≈ 24 g, of rice ≈ 480 g), so volume is knowledge, not arithmetic.
 */
const VOLUME_RE = /\b(?:cups?|tbsps?|tablespoons?|tsps?|teaspoons?|ml|milliliters?|l|liters?|litres?|pints?|quarts?|gallons?|fl\.?\s*oz|fluid\s+ounces?)\b/i;

/** Unit nouns denoting a portion OF a food ("3 slices of bacon" → 'slice'). */
const PORTION_NOUNS = ['slice', 'slices', 'piece', 'pieces', 'strip', 'strips',
  'link', 'links', 'wing', 'wings', 'scoop', 'scoops', 'serving', 'servings'];

export type ParsedQuantity =
  | { kind: 'weight'; grams: number }
  /** "N oz" beside a container: fluid or weight ounces depends on the match. */
  | { kind: 'ambiguousOz'; ounces: number; likelyLiquid: boolean }
  | { kind: 'count'; count: number; unitNoun: string | null; portionOf: string | null; idiom?: string }
  | { kind: 'fraction'; fraction: number; ofWhole: true; food: string }
  | { kind: 'whole'; count: 1 };

function singular(w: string): string {
  const s = w.toLowerCase();
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('ses') || s.endsWith('ches') || s.endsWith('shes')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

function numOf(tok: string | undefined | null): number | null {
  if (tok == null) return null;
  const t = String(tok).toLowerCase().trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t in NUM_WORDS ? NUM_WORDS[t] : null;
}

/** Strip a leading meal frame so an opening quantity is still seen as leading. */
function stripFrame(t: string): string {
  return t
    .replace(/^\s*(?:for\s+)?(?:breakfast|lunch|dinner|snack|brunch)\b[:,]?\s*/i, '')
    .replace(/^\s*(?:i\s+)?(?:had|ate|got|have|grabbed|made)\b\s*/i, '')
    .replace(/^\s*(?:for\s+)?(?:breakfast|lunch|dinner|snack|brunch)\b[:,]?\s*/i, '')
    .trim();
}

/** How many distinct quantity mentions the text carries. */
function countsIn(text: string): number {
  const words = Object.keys(NUM_WORDS).filter((w) => w !== 'a' && w !== 'an').join('|');
  const hits = text.match(new RegExp(`\\b(?:\\d+(?:\\.\\d+)?|${words})\\b`, 'gi')) ?? [];
  const dozenPairs = (text.match(/\b(?:half a dozen|a half dozen)\b/g) ?? []).length;
  return hits.length - dozenPairs;
}

/** The noun a count applies to: an explicit portion noun, else the head noun. */
function unitFrom(text: string): { unitNoun: string | null; portionOf: string | null } {
  const pm = text.match(new RegExp(`\\b(${PORTION_NOUNS.join('|')})\\s+of\\s+(.+)$`, 'i'));
  if (pm) return { unitNoun: singular(pm[1]), portionOf: pm[2].trim() };
  const words = text.replace(/[^a-z\s-]/g, ' ').trim().split(/\s+/);
  const last = words[words.length - 1];
  return { unitNoun: last ? singular(last) : null, portionOf: null };
}

/**
 * Parse the single leading quantity of a food description, or null when nothing
 * is confidently parseable (the caller then keeps the model's own reading).
 */
export function parseQuantity(input: string | null | undefined): ParsedQuantity | null {
  if (!input || typeof input !== 'string') return null;
  const text = stripFrame(input.toLowerCase().replace(/\s+/g, ' '));

  // Multiple quantities ("3 eggs and 2 slices of toast") mean the leading number
  // may not govern the whole entry. Segmentation is the model's job.
  if (countsIn(text) > 1) return null;

  // MULTI-ITEM text, even with a single stated count. "two scrambled eggs and a
  // slice of whole wheat toast" carries one number governing only the eggs — and
  // unitFrom() reads the LAST noun, so firing here would multiply the TOAST by
  // two. Found by auditing against the 55 in-dist eval sentences; the gate's
  // terse single-food inputs never exposed it.
  if (/\s(?:and|with|plus)\s|[,;+]|\band\b/.test(text)) return null;

  // Volume needs the food's density — leave it to the model.
  if (VOLUME_RE.test(text)) return null;

  // A bare "oz" beside a container is AMBIGUOUS: "a 12 oz can of cola" means 12
  // FLUID ounces (~355 g), but "a 12 oz can of tuna" means 12 weight ounces
  // (340 g). Which one depends on whether the CONTENTS are liquid — knowledge
  // the grammar does not have, but the matched foods.db row does (its category
  // and its fl-oz portion labels). So report the ambiguity instead of guessing
  // or declining, and let the resolver settle it against the match.
  //
  // Declining was the earlier behaviour and it left a real hole: on "a 12 oz
  // can of coke" the v10 model returns 4572 g deterministically, while the
  // capitalised "A 12 oz can of coke" returns 368 g — a 12x swing on one letter,
  // in the single most common thing people log.
  const ozm = text.match(/\b(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/i);
  if (ozm && CONTAINER_RE.test(text)) {
    return {
      kind: 'ambiguousOz',
      ounces: Number(ozm[1]),
      likelyLiquid: DRINK_NOUN_RE.test(text) && DRINK_CONTAINER_RE.test(text),
    };
  }

  // --- 1. absolute weight, FIRST so "a half pound patty" is never count 0.5
  const wm = text.match(new RegExp(
    `\\b(?:(${NUM_WORD_RE}|\\d+(?:\\.\\d+)?)\\s+)?(?:(half|quarter|third)\\s+(?:a\\s+|an\\s+)?)?(${WEIGHT_RE})\\b`, 'i'));
  if (wm) {
    const [, numTok, fracTok, unitTok] = wm;
    let n = numOf(numTok);
    const frac = fracTok ? FRACTIONS[fracTok.toLowerCase()] : null;
    if (frac != null) n = (n == null || n === 1) ? frac : n * frac;
    else if (n == null) n = 1;
    const grams = n * WEIGHT_G[unitTok.toLowerCase()];
    if (grams > 0 && grams < 5000) return { kind: 'weight', grams: Math.round(grams) };
  }

  // --- 2. dozen idioms, before the generic number scan
  if (/\b(?:half a dozen|a half dozen)\b/.test(text)) {
    return { kind: 'count', count: 6, ...unitFrom(text), idiom: 'half-dozen' };
  }
  if (/\b(?:a dozen|dozen)\b/.test(text)) {
    return { kind: 'count', count: 12, ...unitFrom(text), idiom: 'dozen' };
  }

  // --- 3. fraction of a WHOLE dish ("a quarter of the lasagna")
  const fm = text.match(/\b(?:an?\s+)?(half|quarter|third)\s+(?:of\s+)?(?:the|a|an)\s+([a-z][a-z\s-]*)/i);
  if (fm) {
    return { kind: 'fraction', fraction: FRACTIONS[fm[1].toLowerCase()], ofWhole: true, food: fm[2].trim() };
  }

  // --- 4. whole item / container
  if (/\b(?:a|an|the|one)\s+(?:whole|entire|full)\b/.test(text) || /\bfamily size\b/.test(text)) {
    return { kind: 'whole', count: 1 };
  }

  // --- 5. leading count. A bare "a"/"an" is an article, not an informative
  // count — treating every "a" as confident would override the model on exactly
  // the vague inputs it should be handling.
  const cm = text.match(new RegExp(`^(${NUM_WORD_RE}|\\d+)\\s+(.+)$`, 'i'));
  if (cm) {
    const n = numOf(cm[1]);
    if (n != null && n > 1) return { kind: 'count', count: n, ...unitFrom(text) };
  }

  return null;
}
