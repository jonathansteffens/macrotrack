// Deterministic quantity grammar for food-entry text.
//
// WHY THIS EXISTS. The estimator model does five jobs at once: segment the text,
// name each food, parse how much, infer unstated portions, and guess macros for
// foods the DB lacks. Three of those need world knowledge and are a good use of
// a model. Parsing "how much" is not — it is arithmetic and idiom lookup, where
// a grammar is exact and a sampled model is probabilistic. Every quantity
// failure in the v9 adversarial gate was a parse error, not a knowledge error:
//
//   "half a dozen bagels"              -> count 12   (the idiom is 6)
//   "a half pound turkey burger patty" -> count 0.5  (a weight read as a count)
//   "20 chicken nuggets"               -> count null (count dropped entirely)
//   "two beers"                        -> count null (word-form count dropped)
//   "a pound of ground beef"           -> 182 g      (1 lb is 454 g, exactly)
//
// Schema v2 already moved the MULTIPLICATION out of the model and into code
// ("the model copies counts, code multiplies"), which fixed the "10 tacos -> 1
// taco" class outright. This module is the same move one step earlier: take the
// PARSE too, and leave the model the jobs only it can do.
//
// Designed to be used as a CONFIDENT OVERRIDE, not a replacement: it reports
// what it is sure of and stays silent otherwise, so tangled input ("had like
// 3-4 tacos ish", "two burgers and fries") still falls through to the model
// rather than being mis-parsed by a rule that half-matches.
//
// Pure text -> quantity. No DB, no model, no I/O.

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, sixteen: 16,
  twenty: 20, dozen: 12,
};
const NUM_WORD_RE = Object.keys(NUM_WORDS).join('|');

// Weight units -> grams. Exact conversions; this is the whole point.
const WEIGHT_G = {
  g: 1, gram: 1, grams: 1, gm: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
};
const WEIGHT_RE = Object.keys(WEIGHT_G).join('|');

// Leading fraction words, as multipliers of a following weight unit or dish.
const FRACTIONS = { half: 0.5, quarter: 0.25, third: 0.33 };

// Container words that make a bare "oz" ambiguous between weight and fluid.
const CONTAINER_RE = /\b(?:cans?|bottles?|glass(?:es)?|mugs?|pints?|cartons?|jugs?|boxes?|packs?)\b/i;

// Volume measures — and "fl oz", which must never reach the weight table where
// a bare "oz" means 28.35 g. Grams per unit volume depends on the food.
const VOLUME_RE = /\b(?:cups?|tbsps?|tablespoons?|tsps?|teaspoons?|ml|milliliters?|l|liters?|litres?|pints?|quarts?|gallons?|fl\.?\s*oz|fluid\s+ounces?)\b/i;

// Unit nouns that denote a portion OF a food rather than the food itself
// ("3 slices of bacon" -> unit 'slice'), so the caller knows to look up grams
// per SLICE rather than per whole food.
const PORTION_NOUNS = new Set(['slice', 'slices', 'piece', 'pieces', 'strip', 'strips',
  'link', 'links', 'wing', 'wings', 'scoop', 'scoops', 'serving', 'servings']);

const singular = (w) => {
  const s = w.toLowerCase();
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('ses') || s.endsWith('ches') || s.endsWith('shes')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
};

const numOf = (tok) => {
  if (tok == null) return null;
  const t = String(tok).toLowerCase().trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (t in NUM_WORDS) return NUM_WORDS[t];
  return null;
};

// Strip a leading meal frame ("for lunch I had ...") so the quantity that opens
// the actual description is still seen as leading.
const stripFrame = (t) => t
  .replace(/^\s*(?:for\s+)?(?:breakfast|lunch|dinner|snack|brunch)\b[:,]?\s*/i, '')
  .replace(/^\s*(?:i\s+)?(?:had|ate|got|have|grabbed|made)\b\s*/i, '')
  .replace(/^\s*(?:for\s+)?(?:breakfast|lunch|dinner|snack|brunch)\b[:,]?\s*/i, '')
  .trim();

/**
 * Parse the single leading quantity of a food description.
 *
 * Returns null when nothing is confidently parseable — the caller should then
 * keep whatever the model produced. Otherwise:
 *   { kind: 'weight',   grams }                       absolute, count stays null
 *   { kind: 'count',    count, unitNoun, portionOf }  multiply by grams-per-unit
 *   { kind: 'fraction', fraction, ofWhole: true }     fraction of the WHOLE dish
 *   { kind: 'whole',    count: 1 }                    one entire item/container
 */
export function parseQuantity(input) {
  if (!input || typeof input !== 'string') return null;
  const text = stripFrame(input.toLowerCase().replace(/\s+/g, ' '));

  // Multiple quantities ("two burgers and fries", "3 eggs and 2 slices of toast")
  // mean the leading number may not govern the whole entry. Segmentation is the
  // model's job, so stay silent rather than attach the count to the wrong food.
  if (countsIn(text) > 1) return null;

  // MULTI-ITEM text, even with a single stated count. "two scrambled eggs and a
  // slice of whole wheat toast" carries one number, but it governs only the
  // eggs — and unitFrom() reads the LAST noun, so firing here would multiply the
  // TOAST by two. Any conjunction or list separator means segmentation is
  // needed first, which is the model's job. (Found by auditing the grammar
  // against the 55 in-dist eval sentences; the adversarial gate's terse
  // single-food inputs never exposed it.)
  if (/\s(?:and|with|plus)\s|[,;+]|\band\b/.test(text)) return null;

  // VOLUME measures need the food's density to become grams ("three cups of
  // air-popped popcorn" is ~24 g, "three cups of rice" ~480 g). That is
  // knowledge, not arithmetic — leave it to the model. Weight units below are
  // different: those conversions are exact.
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
  if (ozm && CONTAINER_RE.test(text)) return { kind: 'ambiguousOz', ounces: Number(ozm[1]) };

  // --- 1. absolute weight: "a pound of ground beef", "8 oz steak", "150 g of X"
  // Checked FIRST so "a half pound patty" reads as a weight, never as count 0.5.
  const wm = text.match(new RegExp(
    `\\b(?:(${NUM_WORD_RE}|\\d+(?:\\.\\d+)?)\\s+)?(?:(half|quarter|third)\\s+(?:a\\s+|an\\s+)?)?(${WEIGHT_RE})\\b`, 'i'));
  if (wm) {
    const [, numTok, fracTok, unitTok] = wm;
    let n = numOf(numTok);
    const frac = fracTok ? FRACTIONS[fracTok.toLowerCase()] : null;
    // "a half pound" / "half a pound" -> 0.5 lb; "2 lbs" -> 2; "a pound" -> 1.
    if (frac != null) n = (n == null || n === 1) ? frac : n * frac;
    else if (n == null) n = 1;
    const grams = n * WEIGHT_G[unitTok.toLowerCase()];
    if (grams > 0 && grams < 5000) return { kind: 'weight', grams: Math.round(grams) };
  }

  // --- 2. dozen idioms, before the generic number scan ("half a dozen" is 6,
  // not 0.5 and not 12 — the v9 bagels failure).
  if (/\b(?:half a dozen|a half dozen)\b/.test(text)) {
    return { kind: 'count', count: 6, ...unitFrom(text), idiom: 'half-dozen' };
  }
  if (/\b(?:a dozen|dozen)\b/.test(text)) {
    return { kind: 'count', count: 12, ...unitFrom(text), idiom: 'dozen' };
  }

  // --- 3. fraction OF A WHOLE DISH: "a quarter of the lasagna", "half a pizza".
  // The fraction applies to the whole dish, not to one serving of it.
  const fm = text.match(/\b(?:an?\s+)?(half|quarter|third)\s+(?:of\s+)?(?:the|a|an)\s+([a-z][a-z\s-]*)/i);
  if (fm) {
    return { kind: 'fraction', fraction: FRACTIONS[fm[1].toLowerCase()], ofWhole: true,
      food: fm[2].trim() };
  }

  // --- 4. whole item / container: "a whole pizza", "the whole bag of chips"
  if (/\b(?:a|an|the|one)\s+(?:whole|entire|full)\b/.test(text) || /\bfamily size\b/.test(text)) {
    return { kind: 'whole', count: 1 };
  }

  // --- 5. leading count: "20 chicken nuggets", "two beers", "5 slices of pizza"
  const cm = text.match(new RegExp(`^(${NUM_WORD_RE}|\\d+)\\s+(.+)$`, 'i'));
  if (cm) {
    const n = numOf(cm[1]);
    // A bare "a"/"an" is an article, not an interesting count — "a burger" is
    // count 1 but carries no information the model does not already have, and
    // treating every "a" as a confident count would override the model on
    // exactly the vague inputs it should be handling.
    if (n != null && n > 1) return { kind: 'count', count: n, ...unitFrom(text) };
  }

  return null;
}

// How many distinct quantity mentions does the text carry? Used to bail out of
// multi-item entries, where attaching the leading count is unsafe.
function countsIn(text) {
  const re = new RegExp(`\\b(?:\\d+(?:\\.\\d+)?|${Object.keys(NUM_WORDS).filter((w) => w !== 'a' && w !== 'an').join('|')})\\b`, 'gi');
  const hits = text.match(re) ?? [];
  // "half a dozen" is one quantity spelled with two tokens.
  const dozenPairs = (text.match(/\b(?:half a dozen|a half dozen)\b/g) ?? []).length;
  return hits.length - dozenPairs;
}

// The noun the count applies to: an explicit portion noun ("5 slices of pizza"
// -> slice, of pizza) or the head noun of the food itself ("20 chicken nuggets"
// -> nugget).
function unitFrom(text) {
  const pm = text.match(new RegExp(`\\b(${[...PORTION_NOUNS].join('|')})\\s+of\\s+(.+)$`, 'i'));
  if (pm) return { unitNoun: singular(pm[1]), portionOf: pm[2].trim() };
  const words = text.replace(/[^a-z\s-]/g, ' ').trim().split(/\s+/);
  const last = words[words.length - 1];
  return { unitNoun: last ? singular(last) : null, portionOf: null };
}

export const _internals = { singular, numOf, unitFrom, countsIn, WEIGHT_G, NUM_WORDS };
