/**
 * Matches a claimed food name against the curated portion tables.
 *
 * KEEP IN SYNC with the same logic in tools/eval/quantity-sim.mjs (and the eval
 * mirrors that import it), or the offline gate stops predicting app behaviour.
 *
 * The matching rule is deliberately strict: every token of the table key must
 * appear in the query. Head-noun agreement alone is not enough — "two slices of
 * cake" shares its head noun with the pool entry "rice cake", and borrowing its
 * 9 g/piece turns 202 g of cake into 18 g. That was a real regression caught in
 * simulation before any of this shipped.
 */

import type { FoodItem } from '../types';
import { PIECE_GRAMS, DISH_GRAMS } from './portions';

/**
 * A US fluid ounce of a water-like drink, vs a weight ounce. The two differ by
 * only ~4%, but WHICH applies is a 12x question when the model is left to guess:
 * on "a 12 oz can of coke" it returns 4572 g, while the capitalised
 * "A 12 oz can of coke" returns 368 g — deterministically, on one letter.
 */
export const FL_OZ_G = 29.5735;
export const WEIGHT_OZ_G = 28.3495;

const DRINK_CATEGORY_RE = /beverage|drink|beer|wine|smoothie|soda|juice/i;

/**
 * Is the matched food a liquid? foods.db knows: an explicit ml unit, a drink-ish
 * category (Beverages / Soft drinks / Beer / Wine / ...), or portions labelled
 * in fl oz. Returns null with no match, meaning "cannot say — keep the model's
 * answer".
 */
export function isLiquidFood(match: FoodItem | null): boolean | null {
  if (!match) return null;
  if (match.unit === 'ml') return true;
  const cat = match.category ?? '';
  if (DRINK_CATEGORY_RE.test(cat)) {
    // "Fruits and Fruit Juices" is a MIXED USDA category — the 'Juices' in
    // its NAME must not make every banana a beverage. For fruit categories
    // the item's own name decides; pure drink categories stay categorical.
    // KEEP IN SYNC with tools/parse/quantity-override.mjs.
    if (!/fruit/i.test(cat)) return true;
    if (/juice|smoothie|nectar|drink|beverage/i.test(match.name)) return true;
  }
  return match.portions.some((p) => /fl\s*oz/i.test(p.label));
}

/** Brand/size words carry no portion information. */
const STOP_TOKENS = new Set(['mcdonalds', 'krispy', 'kreme', 'taco', 'bell', 'wendys', 'burger',
  'king', 'dominos', 'from', 'the', 'a', 'an', 'of', 'with', 'and', 'fresh', 'homemade']);

/** Spellings the pools and the model disagree on. */
const SYNONYM: Record<string, string> = {
  donut: 'doughnut', mcnugget: 'nugget', potsticker: 'dumpling', fry: 'french fry',
};

function singular(w: string): string {
  const s = w.toLowerCase();
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

function normTok(w: string): string {
  let s = singular(String(w).toLowerCase().replace(/[^a-z]/g, ''));
  // "mcnuggets" -> "nuggets" -> "nugget"; guarded on length so "mac" survives.
  if (s.startsWith('mc') && s.length > 4) s = singular(s.slice(2));
  return SYNONYM[s] ?? s;
}

function tokens(s: string | null | undefined): string[] {
  return String(s ?? '').split(/\s+/).map(normTok).filter((t) => t && !STOP_TOKENS.has(t));
}

function lookup<T extends { grams: number }>(
  table: Record<string, T>, name: string | null | undefined, unitNoun?: string | null
): (T & { key: string }) | null {
  const want = tokens(name);
  if (!want.length) return null;
  const head = want[want.length - 1];
  const unitHead = unitNoun ? normTok(unitNoun) : null;
  let best: (T & { key: string; score: number }) | null = null;
  for (const [key, val] of Object.entries(table)) {
    const kt = tokens(key);
    if (!kt.length) continue;
    const kHead = kt[kt.length - 1];
    if (!(kHead === head || (unitHead && kHead === unitHead))) continue;
    // Key must be a SUBSET of the query — see the "rice cake" note above.
    if (kt.some((t) => !want.includes(t))) continue;
    const score = kt.length; // the more specific match wins ("mini muffin" > "muffin")
    if (!best || score > best.score) best = { ...val, key, score };
  }
  return best;
}

/** Grams of one piece of the named food, or null when nothing matches cleanly. */
export function lookupPiece(name: string | null | undefined, unitNoun?: string | null) {
  return lookup(PIECE_GRAMS, name, unitNoun);
}

/** Grams of the whole dish, for fractions and "a whole X". */
export function lookupDish(name: string | null | undefined) {
  return lookup(DISH_GRAMS, name, null);
}
