// Offline simulation: how much of the adversarial gate's QUANTITY failure is
// fixable without touching the model?
//
// Replays saved gate results (runs/adversarial/<tag>-q4.json) and recomputes
// each band case's total grams under five architectures, scoring every one with
// the SAME canonical classifier the gate uses. No GPU, no server, no retrain —
// the model's own output is already on disk, so this measures the ceiling of
// each lever before anyone pays for a training round.
//
//   model         baseline: the model parses the quantity AND supplies grams-per-unit
//   db            model parses; grams-per-unit from foods.db portions_json
//   grammar       tools/parse/quantity.mjs parses; model supplies grams-per-unit
//   grammar+db    grammar parses; DB supplies grams-per-unit
//   grammar+table grammar parses; the generator's curated pool weights supply
//                 grams-per-unit and whole-dish weights   (the hybrid proposal)
//
//   node tools/eval/quantity-sim.mjs [tag=v9] [--verbose]
//
// Measured over v8/v9/v10 (within-tolerance / catastrophic):
//   model          70.7-81.0%  /  5.2-6.9%
//   db             63.8-70.7%  / 12.1-15.5%   DB portion labels are inconsistent
//   grammar        75.9-87.9%  /  5.2-6.9%
//   grammar+table  89.7-93.1%  /  0.0-1.7%    <- clears both bars on every model
//
// The spread across three model revisions collapses from 10.3 points (baseline)
// to 3.4 (grammar+table): the hybrid turns a model lottery into a stable system.
//
// `model` mode reproduces grade.mjs's numbers for the same file, which is what
// makes the other four comparable to the shipped gate figures.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuantity } from '../parse/quantity.mjs';
import { applyQuantityOverride, lookupPiece, lookupDish } from '../parse/quantity-override.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TAG = process.argv.find((a) => !a.startsWith('--') && /^v\d+$/.test(a)) ?? 'v9';
const VERBOSE = process.argv.includes('--verbose');

const db = new DatabaseSync(join(ROOT, 'mobile/assets/foods.db'));
const portionStmt = db.prepare('SELECT portions_json FROM foods WHERE name = ?');

// ---- canonical quantity classifier (verbatim from tools/eval/adversarial/grade.mjs)
function classify(row) {
  const { lo, hi } = row.expect;
  const total = row.totalGrams;
  if (total >= lo && total <= hi) return 'exact';
  const ratio = total < lo ? lo / total : total / hi;
  if (ratio <= 1.4) return 'close';
  if (ratio <= 3) return 'miss';
  return 'CATASTROPHIC';
}

// Volume/weight labels are not per-PIECE weights; only accept them when the
// caller is actually asking for that unit.
const MEASURE_LABEL = /\b(cup|tbsp|tablespoon|tsp|teaspoon|fl oz|fluid ounce|oz|ounce|g|gram|ml|liter|litre|quart|pint|gallon)\b/i;
const singular = (w) => {
  const s = String(w).toLowerCase().trim();
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
};

/**
 * Grams of ONE `unitNoun` of the DB row `dbName`, from portions_json.
 * Handles both "1 nugget" = 16 and "4 pieces" = 64 (-> 16).
 * Returns null when the row has no portion that denotes a single countable unit.
 */
export function perUnitGrams(dbName, unitNoun) {
  if (!dbName) return null;
  const row = portionStmt.get(dbName);
  if (!row?.portions_json) return null;
  let portions;
  try { portions = JSON.parse(row.portions_json); } catch { return null; }
  if (!Array.isArray(portions)) return null;

  const want = unitNoun ? singular(unitNoun) : null;
  const candidates = [];
  for (const p of portions) {
    if (!p?.label || !p.grams) continue;
    const m = String(p.label).match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    const label = m[2].toLowerCase().trim();
    if (!n) continue;
    const per = p.grams / n;
    const labelHead = singular(label.split(/[\s,]+/)[0]);
    const isMeasure = MEASURE_LABEL.test(label);
    // Exact unit match ("1 nugget" for unitNoun 'nugget', "5 pieces" for 'piece')
    if (want && (labelHead === want || label.includes(want))) {
      candidates.push({ per, rank: isMeasure ? 2 : 0, label: p.label });
    } else if (!isMeasure && /\b(piece|item|nugget|slice|each)\b/.test(label)) {
      // Generic single-unit portion — usable when the food's own noun is absent.
      candidates.push({ per, rank: 1, label: p.label });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0].per;
}

// ---- recompute one case's total under a given architecture -----------------
// Only the FIRST item is modelled: every band case is a single-food entry, and
// the grammar deliberately declines multi-quantity text.
function simulate(row, mode) {
  const item = (row.rawItems ?? [])[0];
  const resolved = (row.resolved ?? [])[0];
  const baseline = row.totalGrams;
  if (!item) return { total: baseline, note: 'no items' };

  const modelCount = item.count;
  const parsed = mode.startsWith('grammar') ? parseQuantity(row.text) : null;
  const useDb = mode.endsWith('db');
  const dbUnit = () => perUnitGrams(resolved?.matched, parsed?.unitNoun ?? headNoun(item.name));

  // The per-unit weight the RESOLVER effectively used, recovered from the
  // baseline total. This preserves resolver behaviour the raw claim does not
  // show — notably the branded-serving snap, which replaces the model's
  // unit_grams for chain items ("2 big macs" resolves via the Big Mac serving,
  // not the model's 119 g guess). Recomputing from item.unit_grams instead
  // would silently discard that and manufacture regressions.
  const effectiveUnit = modelCount ? baseline / modelCount : null;

  const useTable = mode.endsWith('table');

  // The SHIPPING architecture: delegate to the exact override the app runs
  // (tools/parse/quantity-override.mjs, mirrored by resolver.ts), so the number
  // this simulation reports is produced by the code that will run on device —
  // not by a re-implementation that could quietly diverge from it.
  if (useTable) {
    const total = applyQuantityOverride(item, row.text, baseline);
    return { total, note: total === baseline ? 'deferred to model' : describeOverride(parsed, item, row.text) };
  }

  // Grammar found an absolute weight -> it IS the answer; exact by construction.
  if (parsed?.kind === 'weight') return { total: parsed.grams, note: `grammar weight ${parsed.grams}g` };

  // Without the curated table there is no whole-dish weight to apply.
  if (parsed?.kind === 'fraction') return { total: baseline, note: 'fraction: deferred to model' };
  if (parsed?.kind === 'whole') return { total: baseline, note: 'whole: deferred to model' };

  if (useDb && !parsed) {
    // db-only ablation: keep the model's count, swap in the DB per-unit weight.
    const d = dbUnit();
    if (modelCount == null || d == null) return { total: baseline, note: 'db: nothing to swap' };
    return { total: Math.round(modelCount * d), note: `${modelCount} x db unit ${d.toFixed(1)}g` };
  }

  const count = parsed?.kind === 'count' ? parsed.count : modelCount;
  if (count == null) return { total: baseline, note: 'no count' };

  // Reached only for the non-table modes; the table path returned above.
  const tableUnit = null;
  // The grammar agrees with the model and no table weight applies -> change
  // nothing. An override is only warranted where sources actually disagree;
  // otherwise the resolver's own result (snapping and all) is already better.
  if (count === modelCount && !useDb && !tableUnit) return { total: baseline, note: 'agrees with model' };

  let unit = effectiveUnit;
  let src = 'resolver unit';
  if (tableUnit) { unit = tableUnit.val.grams; src = `table ${tableUnit.key} ${unit}g/${tableUnit.val.unit}`; }
  if (useDb) {
    const d = dbUnit();
    if (d != null) { unit = d; src = `db unit ${d.toFixed(1)}g`; }
  }
  if (unit == null) {
    // The model emitted a flat gram total and ignored the count, so there is no
    // per-unit weight to scale. The DB is the only remaining source.
    const d = dbUnit();
    if (d == null) return { total: baseline, note: 'no unit weight available' };
    unit = d; src = `db unit ${d.toFixed(1)}g`;
  }
  if (count === modelCount && useDb && src === 'resolver unit') return { total: baseline, note: 'agrees with model' };
  return { total: Math.round(count * unit), note: `${count} x ${src}` };
}

// Human-readable note for an override that changed the answer.
function describeOverride(parsed, item, text) {
  if (!parsed) return 'override';
  if (parsed.kind === 'weight') return `grammar weight ${parsed.grams}g`;
  if (parsed.kind === 'fraction') {
    const d = lookupDish(parsed.food) ?? lookupDish(item.name);
    return d ? `${parsed.fraction} x whole ${d.key} ${d.grams}g` : 'fraction';
  }
  if (parsed.kind === 'whole') {
    const d = lookupDish(item.name);
    return d ? `whole ${d.key} ${d.grams}g` : 'whole';
  }
  const p = lookupPiece(item.name, parsed.unitNoun);
  return p ? `${parsed.count} x table ${p.key} ${p.grams}g/${p.unit}` : `${parsed.count} x resolver unit`;
}

const headNoun = (name) => (name ? singular(String(name).trim().split(/\s+/).pop()) : null);

// ---- run all modes ---------------------------------------------------------
const file = join(ROOT, 'runs/adversarial', `${TAG}-q4.json`);
const rows = JSON.parse(readFileSync(file, 'utf8')).filter((r) => r.expect);
const MODES = ['model', 'db', 'grammar', 'grammar+db', 'grammar+table'];
const results = {};

for (const mode of MODES) {
  const graded = rows.map((r) => {
    const { total, note } = mode === 'model'
      ? { total: r.totalGrams, note: 'baseline' }
      : simulate(r, mode);
    const verdict = classify({ expect: r.expect, totalGrams: total });
    return { id: r.id, text: r.text, expect: r.expect, total, note, verdict };
  });
  const within = graded.filter((g) => g.verdict === 'exact' || g.verdict === 'close').length;
  const cata = graded.filter((g) => g.verdict === 'CATASTROPHIC').length;
  results[mode] = { graded, within, cata };
}

const n = rows.length;
console.log(`quantity simulation over ${n} band cases from ${TAG}-q4.json\n`);
console.log('mode          within-tolerance      catastrophic');
for (const mode of MODES) {
  const { within, cata } = results[mode];
  console.log(`  ${mode.padEnd(12)}${String(within).padStart(3)}/${n} (${(within / n * 100).toFixed(1)}%)`.padEnd(38) +
    `${cata}/${n} (${(cata / n * 100).toFixed(1)}%)`);
}

// Which cases each lever fixes or breaks, relative to the model baseline.
const base = Object.fromEntries(results.model.graded.map((g) => [g.id, g.verdict]));
const ok = (v) => v === 'exact' || v === 'close';
for (const mode of MODES.slice(1)) {
  const fixed = results[mode].graded.filter((g) => !ok(base[g.id]) && ok(g.verdict));
  const broke = results[mode].graded.filter((g) => ok(base[g.id]) && !ok(g.verdict));
  console.log(`\n--- ${mode}: fixes ${fixed.length}, breaks ${broke.length} ---`);
  for (const g of fixed) console.log(`  FIX   ${g.id.padEnd(26)} ${String(g.total).padStart(5)}g  band ${g.expect.lo}-${g.expect.hi}   (${g.note})`);
  for (const g of broke) console.log(`  BREAK ${g.id.padEnd(26)} ${String(g.total).padStart(5)}g  band ${g.expect.lo}-${g.expect.hi}   (${g.note})`);
  if (VERBOSE) {
    for (const g of results[mode].graded.filter((x) => !ok(x.verdict))) {
      console.log(`  still ${g.verdict.padEnd(12)} ${g.id.padEnd(26)} ${String(g.total).padStart(5)}g  band ${g.expect.lo}-${g.expect.hi}  (${g.note})`);
    }
  }
}
