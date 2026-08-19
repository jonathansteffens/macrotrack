/**
 * Display units. Grams stay the canonical stored value everywhere — this module
 * only decides how to SHOW an amount.
 *
 * Nobody thinks "355 g of Coke". They think "a 12 oz can". Nobody thinks
 * "150 g of egg" either; they think "3 eggs". The estimator resolves everything
 * to grams because that is what macros scale from, and that is right for
 * storage and wrong for reading.
 *
 * Four display classes, because they want genuinely different units:
 *
 *   serving    servings            — a label says "1 serving (30 g), 140 cal"
 *   drink      fl oz / ml / cups   — a can is 12 fl oz, not 355 g
 *   countable  pieces              — "3 eggs" beats "150 g" or "5.3 oz"
 *   solid      oz / g              — meat and portions people weigh
 *
 * `serving` wins when a food states one, which is what makes a scanned barcode
 * read the way its package does. It applies to recipes too, since a recipe
 * defines its own serving.
 *
 * Grams are always available as the secondary label, so the number the macros
 * were computed from is never hidden. That matters for trust in a nutrition
 * app: a converted number the user cannot reconcile is worse than a gram value
 * they can.
 *
 * Liquid detection and per-piece weights are shared with the quantity hybrid
 * (see docs/quantity-hybrid.md) rather than reinvented: foods.db knows what a
 * drink is, and the curated pool table knows what one nugget weighs.
 */

import { isLiquidFood, lookupPiece } from './ai/portion-lookup';
import type { FoodItem } from './types';

// Weight ounce vs FLUID ounce — different units that share a name. A fluid
// ounce of a water-like drink is ~29.57 g; a weight ounce is 28.3495 g.
// Treating a drink's volume as if it were water is an approximation (a regular
// cola is ~1.04 g/mL), but it is the same approximation nutrition labels make,
// and it is bounded at a few percent.
export const OZ_G = 28.3495;
export const FL_OZ_G = 29.5735;
export const CUP_G = FL_OZ_G * 8;

export type UnitSystem = 'us' | 'metric';
export type FoodClass = 'serving' | 'drink' | 'countable' | 'solid';
/** 'auto' defers to the system default for that class. */
export type UnitChoice = 'auto' | 'serving' | 'piece' | 'floz' | 'ml' | 'cup' | 'oz' | 'g';
/** Same energy, two spellings: US labels say "Cal(ories)", science says kcal. */
export type EnergyUnit = 'Cal' | 'kcal';

export type UnitPrefs = {
  system: UnitSystem;
  /** Per-class override; absent or 'auto' means follow `system`. */
  overrides: Partial<Record<FoodClass, UnitChoice>>;
  /** Display label for energy; default 'Cal' (what US nutrition labels print). */
  energy?: EnergyUnit;
};

export const DEFAULT_UNIT_PREFS: UnitPrefs = { system: 'us', overrides: {}, energy: 'Cal' };

/** The energy display label under the given prefs. */
export function energyLabel(prefs?: Pick<UnitPrefs, 'energy'> | null): string {
  return prefs?.energy === 'kcal' ? 'kcal' : 'Cal';
}

/** Choices offered per class in Settings, in display order. */
export const UNIT_CHOICES: Record<FoodClass, UnitChoice[]> = {
  serving: ['auto', 'serving', 'floz', 'oz', 'g'],
  drink: ['auto', 'floz', 'ml', 'cup', 'g'],
  countable: ['auto', 'piece', 'oz', 'g'],
  solid: ['auto', 'oz', 'g'],
};

const CHOICE_LABELS: Record<UnitChoice, string> = {
  auto: 'Auto',
  serving: 'Servings',
  piece: 'Pieces',
  floz: 'fl oz',
  ml: 'mL',
  cup: 'Cups',
  oz: 'oz',
  g: 'Grams',
};
export const unitChoiceLabel = (c: UnitChoice): string => CHOICE_LABELS[c];

const CLASS_LABELS: Record<FoodClass, string> = {
  serving: 'Packaged foods & recipes',
  drink: 'Drinks',
  countable: 'Countable foods',
  solid: 'Everything else',
};
export const foodClassLabel = (c: FoodClass): string => CLASS_LABELS[c];

function singularize(s: string): string {
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  // -ss and -us endings aren't plurals ("asparagus" must not become "asparagu").
  if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) return s.slice(0, -1);
  return s;
}

// Words that are never the thing being counted. JUNK are qualifier tails to
// drop ("can drained solids" → "can"); GENERIC means "no real noun here" and
// the caller should fall back (a chip may not read "larges" or "items").
const NOUN_JUNK = new Set([
  'eaten', 'cooked', 'raw', 'drained', 'only', 'yield', 'refuse', 'content',
  'contents', 'solid', 'solids', 'unheated', 'prepared', 'frozen', 'ns', 'nfs',
  'size', 'boneless', 'skinless',
]);
const NOUN_GENERIC = new Set([
  'piece', 'pieces', 'unit', 'units', 'item', 'items', 'serving', 'servings',
  'size', 'large', 'medium', 'small', 'regular', 'extra', 'thin', 'thick',
  'snack', 'or', 'and',
]);

/**
 * Distill a label phrase to the noun someone would count in:
 *   "breast, NS as to skin eaten"  → "breast"
 *   "large or thick slice"         → "slice"   (English noun phrases are head-final)
 *   "thigh without skin"           → "thigh"
 *   "slice 1/4 of pie"             → "slice"
 *   "item" / "large"               → ""        (nothing noun-like — caller falls back)
 */
export function headNoun(text: string): string {
  let s = text.toLowerCase().split(/[,(]/)[0];
  s = s.split(/\s+(?:with|without|per|from|of|in)\s+/)[0];
  s = s.replace(/["']/g, ' ').split(/\d/)[0];
  let words = s.trim().split(/\s+/).filter(Boolean);
  // Junk-check the singular form so plural qualifiers ("yields") drop too.
  while (words.length > 0 && NOUN_JUNK.has(singularize(words[words.length - 1]))) words.pop();
  if (words.length > 2) words = [words[words.length - 1]];
  if (words.length === 0 || words.every((w) => NOUN_GENERIC.has(w))) return '';
  return singularize(words.join(' '));
}

/**
 * The first single-unit portion on the matched row, as both a weight and a
 * noun: "1 breast, NS as to skin eaten" (172 g) → 172 g per "breast".
 * Measures ("1 cup") don't count as pieces. Weight and noun come from the SAME
 * portion so the chip can never name one thing and weigh another.
 */
function pieceFromPortions(match: FoodItem | null): { perUnit: number; noun: string } | null {
  for (const p of match?.portions ?? []) {
    if (!p.grams || p.grams <= 0) continue;
    const m = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(p.label);
    if (!m) continue;
    const n = Number(m[1]);
    const label = m[2].toLowerCase();
    // Measures are not pieces — "1 cup" or "1 lb" of something countable is
    // still weight/volume entry, which the oz/g chips already own.
    if (
      !n ||
      /\b(cup|tbsp|tablespoon|tsp|teaspoon|fl oz|fluid|oz|ounce|gram|ml|liter|quart|pint|lb|lbs|pound|pounds|inch|inches|cubic)\b/.test(
        label
      )
    )
      continue;
    return { perUnit: p.grams / n, noun: headNoun(label) || 'piece' };
  }
  return null;
}

/**
 * Grams of one piece of this food, or null when it is not sensibly countable.
 * Prefers the curated pool table (hand-checked against foods.db), then a
 * single-unit portion on the matched row ("1 nugget" = 16 g).
 */
export function pieceGramsFor(name: string, match: FoodItem | null): number | null {
  const curated = lookupPiece(name, null);
  if (curated) return curated.grams;
  return pieceFromPortions(match)?.perUnit ?? null;
}

/**
 * Grams of one stated serving, when the food defines one — a barcode product's
 * label serving (see off.ts) or a recipe's own serving. Null otherwise.
 *
 * This is the unit a packaged food is actually written in: a label says "1
 * serving (30 g), 140 calories", and nobody reads that as 30 grams.
 */
export function servingGramsFor(match: FoodItem | null): number | null {
  for (const p of match?.portions ?? []) {
    if (p.grams > 0 && /^1 serving\b/i.test(p.label)) return p.grams;
  }
  return null;
}

/**
 * Which display class this food belongs to.
 *
 * `liquid` overrides the DB lookup for callers that have no FoodItem — a logged
 * entry keeps only its name, grams and `unit`, and `unit === 'ml'` already says
 * it is a drink.
 */
export function classifyFood(name: string, match: FoodItem | null, liquid?: boolean): FoodClass {
  // A stated serving wins, including for packaged drinks: when a label defines
  // the serving, that is the unit the user is reading off the package. The
  // Settings override exists for anyone who would rather see fl oz.
  if (servingGramsFor(match) != null) return 'serving';
  if (liquid ?? isLiquidFood(match)) return 'drink';
  if (pieceGramsFor(name, match) != null) return 'countable';
  return 'solid';
}

function resolveChoice(cls: FoodClass, prefs: UnitPrefs): UnitChoice {
  const override = prefs.overrides[cls];
  if (override && override !== 'auto') return override;
  const metric = prefs.system === 'metric';
  if (cls === 'serving') return 'serving';
  if (cls === 'drink') return metric ? 'ml' : 'floz';
  if (cls === 'countable') return 'piece';
  return metric ? 'g' : 'oz';
}

/** Trim trailing zeros: 1.0 -> "1", 1.50 -> "1.5". */
function num(n: number, decimals: number): string {
  const r = Number(n.toFixed(decimals));
  return String(r);
}

/** Pluralize a unit noun for a count ("nugget" -> "nuggets"). */
function plural(noun: string, n: number): string {
  if (Math.abs(n - 1) < 1e-9) return noun;
  if (/(s|sh|ch|x|z)$/i.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

export type FormattedAmount = {
  /** What to show the user, e.g. "12 fl oz" or "3 eggs". */
  primary: string;
  /** The canonical amount, e.g. "355 g" — null when primary already IS grams. */
  secondary: string | null;
};

/**
 * Format `grams` of a food for display.
 *
 * @param unitNoun the food's own piece noun when known ("nugget", "egg"); the
 *                 food name is used otherwise, so "3 eggs" reads naturally
 *                 instead of "3 pieces".
 */
export function formatAmount(
  grams: number,
  opts: {
    name: string;
    match: FoodItem | null;
    prefs: UnitPrefs;
    unitNoun?: string | null;
    /** Force the drink class when there is no FoodItem to classify from. */
    liquid?: boolean;
  }
): FormattedAmount {
  const { name, match, prefs } = opts;
  const gramsLabel = `${num(grams, grams < 10 ? 1 : 0)} ${match?.unit === 'ml' ? 'mL' : 'g'}`;
  if (!Number.isFinite(grams) || grams <= 0) return { primary: gramsLabel, secondary: null };

  const cls = classifyFood(name, match, opts.liquid);
  let choice = resolveChoice(cls, prefs);

  if (choice === 'piece') {
    const per = pieceGramsFor(name, match);
    const count = per && per > 0 ? grams / per : null;
    // Half-steps are legitimate ("3.5 eggs"); a count far from any half-step
    // means the user weighed it rather than counted it, and "15.25 nuggets"
    // would be false precision.
    const rounded = count != null ? Math.round(count * 2) / 2 : null;
    if (count != null && rounded != null && rounded >= 0.5 && Math.abs(count - rounded) <= 0.15) {
      const noun = opts.unitNoun ?? pieceNoun(name, match);
      return { primary: `${num(rounded, 1)} ${plural(noun, rounded)}`, secondary: gramsLabel };
    }
    // Not sensibly countable → fall back to the WEIGHT unit for the user's
    // system, not to grams: a US user asking for pieces wants oz when a count
    // is unavailable, not the raw gram value they were trying to avoid.
    choice = prefs.system === 'metric' ? 'g' : 'oz';
  }

  switch (choice) {
    case 'serving': {
      const per = servingGramsFor(match);
      // Without a stated serving there is nothing to count; fall through to the
      // system's weight unit rather than inventing one.
      if (per != null && per > 0) {
        const n = grams / per;
        if (n >= 0.05) {
          const rounded = Number(n.toFixed(1));
          return {
            primary: `${num(rounded, 1)} ${plural('serving', rounded)}`,
            secondary: gramsLabel,
          };
        }
      }
      break;
    }
    case 'floz':
      return { primary: `${num(grams / FL_OZ_G, 1)} fl oz`, secondary: gramsLabel };
    case 'cup':
      return { primary: `${num(grams / CUP_G, 2)} cups`, secondary: gramsLabel };
    case 'ml':
      // mL ≈ g for water-like drinks, the same assumption the DB's own ml unit makes.
      return { primary: `${num(grams, 0)} mL`, secondary: null };
    case 'oz':
      return { primary: `${num(grams / OZ_G, 1)} oz`, secondary: gramsLabel };
    case 'g':
    case 'auto':
      break;
  }
  // 'serving' with no stated serving lands here: use the system's weight unit,
  // not raw grams, for the same reason the piece path does.
  if (choice === 'serving') {
    return prefs.system === 'metric'
      ? { primary: gramsLabel, secondary: null }
      : { primary: `${num(grams / OZ_G, 1)} oz`, secondary: gramsLabel };
  }
  return { primary: gramsLabel, secondary: null };
}

/** The noun to count in ("nugget", "breast", "egg"): curated table first, then
 *  the matched row's unit portion, then the head of the name — all through the
 *  same distiller, so a qualifier word can never become the counting noun. */
export function pieceNoun(name: string, match: FoodItem | null): string {
  const curated = lookupPiece(name, null);
  if (curated?.unit) return curated.unit;
  const fromPortion = pieceFromPortions(match)?.noun;
  if (fromPortion && fromPortion !== 'piece') return fromPortion;
  return headNoun(String(name)) || 'piece';
}

/** One-line label combining both, e.g. "12 fl oz (355 g)". */
export function amountLabel(a: FormattedAmount): string {
  return a.secondary ? `${a.primary} (${a.secondary})` : a.primary;
}

/**
 * Convert a user-entered amount in `choice` units back to grams (for editors).
 *
 * @param perUnit grams of one piece or one serving, for the count-based choices.
 *                Null when unknown, in which case those choices return null
 *                rather than guessing a weight.
 */
export function toGrams(value: number, choice: UnitChoice, perUnit: number | null): number | null {
  if (!Number.isFinite(value)) return null;
  switch (choice) {
    case 'serving':
    case 'piece': return perUnit && perUnit > 0 ? value * perUnit : null;
    case 'floz': return value * FL_OZ_G;
    case 'cup': return value * CUP_G;
    case 'oz': return value * OZ_G;
    case 'ml':
    case 'g': return value;
    case 'auto': return null;
  }
}


// ---- Input side -------------------------------------------------------------
//
// Display and input have to agree: showing "3 nuggets" and then making the user
// type 48 grams to change it is the same mismatch the display work removed, just
// moved one step later. These helpers give an amount FIELD the same
// classification the labels use, so a field opens denominated in the food's own
// unit. Grams stay the stored value — conversion happens at the input boundary
// via toGrams — and grams stay offered as an explicit chip, they just stop being
// the default.

/** Grams of one unit for the count-based choices; null when it converts by a constant. */
export function perUnitGramsFor(
  choice: UnitChoice, name: string, match: FoodItem | null
): number | null {
  if (choice === 'serving') return servingGramsFor(match);
  if (choice === 'piece') return pieceGramsFor(name, match);
  return null;
}

/** Inverse of toGrams: how many `choice` units `grams` is. Null when unknowable. */
export function gramsToUnit(
  grams: number, choice: UnitChoice, perUnit: number | null
): number | null {
  if (!Number.isFinite(grams)) return null;
  switch (choice) {
    case 'serving':
    case 'piece': return perUnit && perUnit > 0 ? grams / perUnit : null;
    case 'floz': return grams / FL_OZ_G;
    case 'cup': return grams / CUP_G;
    case 'oz': return grams / OZ_G;
    case 'ml':
    case 'g': return grams;
    case 'auto': return null;
  }
}

/** One selectable unit on an amount field. */
export type AmountUnit = {
  choice: UnitChoice;
  /** Chip text, pluralised for the food: "servings", "nuggets", "fl oz", "g". */
  label: string;
  /** Grams of one unit, for the count-based choices. */
  perUnit: number | null;
};

/** Chip order per class. Grams is always last and always present. */
const INPUT_UNITS: Record<FoodClass, Record<UnitSystem, UnitChoice[]>> = {
  serving: { us: ['serving', 'oz', 'g'], metric: ['serving', 'g'] },
  drink: { us: ['floz', 'cup', 'ml', 'g'], metric: ['ml', 'floz', 'g'] },
  countable: { us: ['piece', 'oz', 'g'], metric: ['piece', 'g'] },
  solid: { us: ['oz', 'g'], metric: ['g'] },
};

function inputUnitLabel(choice: UnitChoice, name: string, match: FoodItem | null): string {
  switch (choice) {
    case 'serving': return 'servings';
    case 'piece': return `${pieceNoun(name, match)}s`;
    case 'floz': return 'fl oz';
    case 'cup': return 'cups';
    case 'ml': return 'mL';
    case 'oz': return 'oz';
    default: return match?.unit === 'ml' ? 'mL' : 'g';
  }
}

/**
 * Units an amount field should offer, natural unit first and grams last.
 *
 * A count-based unit is dropped when its per-unit weight is unknown, so a chip
 * can never be selected that has no way to convert what the user types.
 */
export function amountUnitOptions(opts: {
  name: string;
  match: FoodItem | null;
  prefs: UnitPrefs;
  liquid?: boolean;
}): AmountUnit[] {
  const cls = classifyFood(opts.name, opts.match, opts.liquid);
  const override = opts.prefs.overrides[cls];
  const ordered = [...INPUT_UNITS[cls][opts.prefs.system]];
  // An explicit Settings override becomes the field's first chip too.
  if (override && override !== 'auto') {
    const i = ordered.indexOf(override);
    if (i > 0) ordered.splice(i, 1);
    if (i !== 0) ordered.unshift(override);
  }
  const out: AmountUnit[] = [];
  for (const choice of ordered) {
    const perUnit = perUnitGramsFor(choice, opts.name, opts.match);
    if ((choice === 'serving' || choice === 'piece') && (perUnit == null || perUnit <= 0)) continue;
    if (out.some((o) => o.choice === choice)) continue;
    out.push({ choice, label: inputUnitLabel(choice, opts.name, opts.match), perUnit });
  }
  if (!out.some((o) => o.choice === 'g')) {
    out.push({ choice: 'g', label: inputUnitLabel('g', opts.name, opts.match), perUnit: null });
  }
  return out;
}

/** The unit an amount field opens in — the first offered option. */
export function defaultAmountUnit(opts: {
  name: string;
  match: FoodItem | null;
  prefs: UnitPrefs;
  liquid?: boolean;
}): AmountUnit {
  return amountUnitOptions(opts)[0];
}

/** Format a converted amount for a text field: enough precision, no noise. */
export function formatAmountValue(value: number, choice: UnitChoice): string {
  const decimals = choice === 'g' || choice === 'ml' ? 1 : 2;
  return String(Number(value.toFixed(decimals)));
}
