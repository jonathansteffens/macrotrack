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
 * @returns grams
 */
export function applyQuantityOverride(item, userText, baseline) {
  if (!userText) return baseline;
  const parsed = parseQuantity(userText);
  if (!parsed) return baseline;

  if (parsed.kind === 'weight') return parsed.grams;

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
