/**
 * Display units. Grams stay the canonical stored value everywhere — this module
 * only decides how to SHOW an amount.
 *
 * Nobody thinks "355 g of Coke". They think "a 12 oz can". Nobody thinks
 * "150 g of egg" either; they think "3 eggs". The estimator resolves everything
 * to grams because that is what macros scale from, and that is right for
 * storage and wrong for reading.
 *
 * Three display classes, because they want genuinely different units:
 *
 *   drink      fl oz / ml / cups   — a can is 12 fl oz, not 355 g
 *   countable  pieces              — "3 eggs" beats "150 g" or "5.3 oz"
 *   solid      oz / g              — meat and portions people weigh
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
export type FoodClass = 'drink' | 'countable' | 'solid';
/** 'auto' defers to the system default for that class. */
export type UnitChoice = 'auto' | 'piece' | 'floz' | 'ml' | 'cup' | 'oz' | 'g';

export type UnitPrefs = {
  system: UnitSystem;
  /** Per-class override; absent or 'auto' means follow `system`. */
  overrides: Partial<Record<FoodClass, UnitChoice>>;
};

export const DEFAULT_UNIT_PREFS: UnitPrefs = { system: 'us', overrides: {} };

/** Choices offered per class in Settings, in display order. */
export const UNIT_CHOICES: Record<FoodClass, UnitChoice[]> = {
  drink: ['auto', 'floz', 'ml', 'cup', 'g'],
  countable: ['auto', 'piece', 'oz', 'g'],
  solid: ['auto', 'oz', 'g'],
};

const CHOICE_LABELS: Record<UnitChoice, string> = {
  auto: 'Auto',
  piece: 'Pieces',
  floz: 'fl oz',
  ml: 'mL',
  cup: 'Cups',
  oz: 'oz',
  g: 'Grams',
};
export const unitChoiceLabel = (c: UnitChoice): string => CHOICE_LABELS[c];

const CLASS_LABELS: Record<FoodClass, string> = {
  drink: 'Drinks',
  countable: 'Countable foods',
  solid: 'Everything else',
};
export const foodClassLabel = (c: FoodClass): string => CLASS_LABELS[c];

/**
 * Grams of one piece of this food, or null when it is not sensibly countable.
 * Prefers the curated pool table (hand-checked against foods.db), then a
 * single-unit portion on the matched row ("1 nugget" = 16 g), ignoring portions
 * that are really measures ("1 cup").
 */
export function pieceGramsFor(name: string, match: FoodItem | null): number | null {
  const curated = lookupPiece(name, null);
  if (curated) return curated.grams;
  for (const p of match?.portions ?? []) {
    if (!p.grams || p.grams <= 0) continue;
    const m = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(p.label);
    if (!m) continue;
    const n = Number(m[1]);
    const label = m[2].toLowerCase();
    if (!n || /\b(cup|tbsp|tablespoon|tsp|teaspoon|fl oz|fluid|oz|ounce|gram|ml|liter|quart|pint)\b/.test(label)) continue;
    return p.grams / n;
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
  if (liquid ?? isLiquidFood(match)) return 'drink';
  if (pieceGramsFor(name, match) != null) return 'countable';
  return 'solid';
}

function resolveChoice(cls: FoodClass, prefs: UnitPrefs): UnitChoice {
  const override = prefs.overrides[cls];
  if (override && override !== 'auto') return override;
  const metric = prefs.system === 'metric';
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
  return { primary: gramsLabel, secondary: null };
}

/** The noun to count in ("nugget", "egg"), derived from the curated table or the name. */
function pieceNoun(name: string, match: FoodItem | null): string {
  const curated = lookupPiece(name, null);
  if (curated?.unit) return curated.unit;
  // Singularize the food's last word: "scrambled eggs" -> "egg".
  const last = String(name).trim().split(/\s+/).pop() ?? 'piece';
  const s = last.toLowerCase();
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s || 'piece';
}

/** One-line label combining both, e.g. "12 fl oz (355 g)". */
export function amountLabel(a: FormattedAmount): string {
  return a.secondary ? `${a.primary} (${a.secondary})` : a.primary;
}

/** Convert a user-entered amount in `choice` units back to grams (editors). */
export function toGrams(value: number, choice: UnitChoice, perPiece: number | null): number | null {
  if (!Number.isFinite(value)) return null;
  switch (choice) {
    case 'floz': return value * FL_OZ_G;
    case 'cup': return value * CUP_G;
    case 'oz': return value * OZ_G;
    case 'ml':
    case 'g': return value;
    case 'piece': return perPiece && perPiece > 0 ? value * perPiece : null;
    case 'auto': return null;
  }
}
