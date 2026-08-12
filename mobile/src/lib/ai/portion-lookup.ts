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

import { PIECE_GRAMS, DISH_GRAMS } from './portions';

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
