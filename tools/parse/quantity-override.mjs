// The quantity override, shared by every offline harness.
//
// MIRRORS mobile/src/lib/ai/{resolver.ts applyQuantityOverride, portion-lookup.ts}.
// Keep the two in sync — the eval harnesses import THIS file, so if it drifts
// from the app the gate stops predicting app behaviour. The repo already uses
// this convention for the branded corroboration guard.
//
// Consumed by tools/eval/quantity-sim.mjs (so the measured architecture is
// literally this code), tools/eval/adversarial/run.mjs, tools/eval/run-eval.mjs
// and tools/chat/playground.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuantity } from './quantity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(readFileSync(join(HERE, 'portions.json'), 'utf8'));

const STOP_TOKENS = new Set(['mcdonalds', 'krispy', 'kreme', 'taco', 'bell', 'wendys', 'burger',
  'king', 'dominos', 'from', 'the', 'a', 'an', 'of', 'with', 'and', 'fresh', 'homemade']);
const SYNONYM = { donut: 'doughnut', mcnugget: 'nugget', potsticker: 'dumpling', fry: 'french fry' };

function singular(w) {
  const s = String(w).toLowerCase();
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}
function normTok(w) {
  let s = singular(String(w).toLowerCase().replace(/[^a-z]/g, ''));
  if (s.startsWith('mc') && s.length > 4) s = singular(s.slice(2));
  return SYNONYM[s] ?? s;
}
const tokens = (s) => String(s ?? '').split(/\s+/).map(normTok).filter((t) => t && !STOP_TOKENS.has(t));

// Every token of the table key must appear in the query. Head-noun agreement
// alone is not enough: "two slices of cake" shares its head with the pool entry
// "rice cake", and borrowing its 9 g/piece turns 202 g of cake into 18 g.
function lookup(group, name, unitNoun) {
  const table = TABLE[group] ?? {};
  const want = tokens(name);
  if (!want.length) return null;
  const head = want[want.length - 1];
  const unitHead = unitNoun ? normTok(unitNoun) : null;
  let best = null;
  for (const [key, val] of Object.entries(table)) {
    const kt = tokens(key);
    if (!kt.length) continue;
    const kHead = kt[kt.length - 1];
    if (!(kHead === head || (unitHead && kHead === unitHead))) continue;
    if (kt.some((t) => !want.includes(t))) continue;
    const score = kt.length;
    if (!best || score > best.score) best = { ...val, key, score };
  }
  return best;
}

// A US fluid ounce of a water-like drink. Weight ounces are 28.3495 g; the
// difference is only ~4%, but which one applies is a 12x question when the
// model is left to guess (see the "12 oz can of coke" note in quantity.mjs).
const FL_OZ_G = 29.5735;
const WEIGHT_OZ_G = 28.3495;

// foods.db knows what a drink is: an explicit ml unit, a drink-ish category
// (Beverages / Soft drinks / Beer / Wine / Sport and energy drinks / ...), or
// portions labelled in fl oz (1207 of 14558 rows carry those).
const DRINK_CATEGORY_RE = /beverage|drink|beer|wine|smoothie|soda|juice/i;
export function isLiquidFood(match) {
  if (!match) return null;               // no match -> caller keeps the model's answer
  if (match.unit === 'ml') return true;
  const cat = match.category ?? '';
  if (DRINK_CATEGORY_RE.test(cat)) {
    // "Fruits and Fruit Juices" is a MIXED USDA category — the 'Juices' in
    // its NAME must not make every banana a beverage. For fruit categories
    // the item's own name decides. KEEP IN SYNC with
    // mobile/src/lib/ai/portion-lookup.ts.
    if (!/fruit/i.test(cat)) return true;
    else if (/juice|smoothie|nectar|drink|beverage/i.test(match.name ?? '')) return true;
  }
  const portions = match.portions_json ?? match.portions;
  const labels = typeof portions === 'string' ? portions : JSON.stringify(portions ?? '');
  return /fl\s*oz/i.test(labels);
}

export const lookupPiece = (name, unitNoun) => lookup('pieces', name, unitNoun);
export const lookupDish = (name) => lookup('dishes', name, null);

/**
 * Deterministic quantity override.
 *
 * @param item     the model's claim item ({ name, count, unit_grams, grams })
 * @param userText the user's original wording, or undefined to disable
 * @param baseline the resolver's own grams — already includes the branded
 *                 serving snap, so recovering per-unit as baseline/count
 *                 preserves that snapping rather than reverting to unit_grams
 * @param match    the resolved foods.db row, used only to settle whether a bare
 *                 "oz" beside a container is fluid or weight
 * @returns grams
 */
export function applyQuantityOverride(item, userText, baseline, match) {
  if (!userText) return baseline;
  const parsed = parseQuantity(userText);
  if (!parsed) return baseline;

  if (parsed.kind === 'weight') return parsed.grams;

  // "12 oz can of X": the DB row settles fluid vs weight. Unmatched -> the model
  // keeps the call, since we have nothing to decide with.
  if (parsed.kind === 'ambiguousOz') {
    // The user's own words win when they name a drink in a drink container:
    // that reading holds regardless of what the claim resolved to, and it
    // survives a garbled model claim that matches nothing (as observed on
    // device). Otherwise the matched row decides; with neither signal there is
    // nothing to decide with, so the model keeps the call.
    const liquid = parsed.likelyLiquid ? true : isLiquidFood(match);
    if (liquid == null) return baseline;
    return Math.round(parsed.ounces * (liquid ? FL_OZ_G : WEIGHT_OZ_G));
  }

  if (parsed.kind === 'fraction') {
    const dish = lookupDish(parsed.food) ?? lookupDish(item.name);
    return dish ? Math.round(parsed.fraction * dish.grams) : baseline;
  }
  if (parsed.kind === 'whole') {
    const dish = lookupDish(item.name);
    return dish ? dish.grams : baseline;
  }

  const piece = lookupPiece(item.name, parsed.unitNoun);
  const effectiveUnit = item.count && item.count > 0 ? baseline / item.count : null;
  if (parsed.count === item.count && !piece) return baseline;
  const unit = piece ? piece.grams : effectiveUnit;
  if (!unit || unit <= 0) return baseline;
  const count = Math.min(24, Math.max(0.25, parsed.count));
  return Math.round(count * unit);
}
