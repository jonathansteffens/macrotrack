// Permanent grader for the adversarial eval tier. Reads a results.json produced
// by ./run.mjs (an array of case objects merged with the model's output +
// resolver totals) and scores it. Read-only; no DB or live model needed.
//
//   node tools/eval/adversarial/grade.mjs results.json
//   node tools/eval/adversarial/grade.mjs results.json --json   # also emit a
//        machine-readable summary object to stdout (after the human report)
//
// Two grading modes, chosen per case by whether it carries an `expect` band:
//
//   QUANTITY (has expect {lo,hi}) — scored with the CANONICAL classify() below,
//   recovered VERBATIM from the v6-v8 QA-gate scoring scripts
//   (gate-analyze-v8b.mjs). It is reproduced here unchanged so scores stay
//   comparable across gate rounds — do NOT re-derive or "improve" it. Notably:
//   grade purely by totalGrams; needs_clarification does NOT fail a quantity
//   case, and there are no lo/2 or hi*2 rules. invalid/error rows are CATASTROPHIC.
//     within-tolerance = exact + close   (the ~75% shipping-bar metric)
//     catastrophic %   = CATASTROPHIC / n (the ~5% bar)
//
//   REGRESSION / SPOT (no expect band) — scored by whichever predicate fields
//   the case carries: expectItems (null => >=1 item; a number => exactly that
//   many), expectAsk (needs_clarification true/false), expectBranded (some
//   resolved item dataType==='branded'), expectNonFood (no items emitted),
//   mustContain / mustNotContain (token presence in item name/db_search_terms).
//   A row with error/invalid FAILs. All present predicates must pass.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const FILE = args.find((a) => !a.startsWith('--'));
if (!FILE) {
  console.error('Usage: node tools/eval/adversarial/grade.mjs results.json [--json]');
  process.exit(1);
}

const rows = JSON.parse(readFileSync(FILE, 'utf8'));

// ---- canonical quantity classifier (verbatim from the v6-v8 gate scripts) ----
function classify(row) {
  const { lo, hi } = row.expect;
  const total = row.totalGrams;
  if (total >= lo && total <= hi) return 'exact';
  const ratio = total < lo ? lo / total : total / hi;
  if (ratio <= 1.4) return 'close';
  if (ratio <= 3) return 'miss';
  return 'CATASTROPHIC';
}

// ---- predicate helpers for regression/spot ----
const itemTokens = (row) =>
  (row.rawItems || [])
    .flatMap((it) => [it.name, ...(it.db_search_terms || [])])
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
const containsToken = (row, tok) => itemTokens(row).some((s) => s.includes(String(tok).toLowerCase()));

// Grade a regression/spot case; returns { pass, why } where why explains a fail.
function gradePredicate(row) {
  if (row.error) return { pass: false, why: `error: ${row.error}` };
  if (row.invalid) return { pass: false, why: 'invalid JSON' };
  const n = (row.rawItems || []).length;

  if ('expectItems' in row) {
    if (row.expectItems === null) {
      if (n < 1) return { pass: false, why: 'expected >=1 item, got 0' };
    } else if (n !== row.expectItems) {
      return { pass: false, why: `expected ${row.expectItems} items, got ${n}` };
    }
  }
  if ('expectAsk' in row) {
    const asked = row.needs_clarification === true;
    if (row.expectAsk === true && !asked) return { pass: false, why: 'expected a clarifying question, none asked' };
    if (row.expectAsk === false && asked) return { pass: false, why: 'asked a clarifying question, should be confident' };
  }
  if (row.expectBranded === true) {
    const branded = (row.resolved || []).some((r) => r.dataType === 'branded');
    if (!branded) return { pass: false, why: 'expected a branded resolved item, none' };
  }
  if (row.expectNonFood === true) {
    if (n !== 0) return { pass: false, why: `expected no food items (non-food), got ${n}` };
  }
  if (Array.isArray(row.mustContain)) {
    const missing = row.mustContain.filter((t) => !containsToken(row, t));
    if (missing.length) return { pass: false, why: `missing required token(s): ${missing.join(', ')}` };
  }
  if (Array.isArray(row.mustNotContain)) {
    const present = row.mustNotContain.filter((t) => containsToken(row, t));
    if (present.length) return { pass: false, why: `contains forbidden token(s): ${present.join(', ')}` };
  }
  return { pass: true, why: null };
}

// ---- score every row ----
const quantRows = [];
const predRows = [];
const failLines = [];

for (const row of rows) {
  if (row.expect && typeof row.expect.lo === 'number') {
    // quantity mode
    let label;
    if (row.invalid || row.error) label = 'CATASTROPHIC';
    else label = classify(row);
    quantRows.push({ row, label });
    if (label !== 'exact') {
      const tg = row.invalid || row.error ? (row.error ? 'ERR' : 'BAD') : Math.round(row.totalGrams);
      const tag = label === 'close' ? 'NEAR' : label === 'miss' ? 'MISS' : 'CATA';
      failLines.push(`  ${tag.padEnd(4)} ${row.id}  "${row.text}"  totalGrams=${tg} band=${row.expect.lo}-${row.expect.hi}`);
    }
  } else {
    // regression / spot mode
    const { pass, why } = gradePredicate(row);
    predRows.push({ row, pass, why });
    if (!pass) failLines.push(`  FAIL ${row.id}  "${row.text}"  ${why}`);
  }
}

// ---- aggregate ----
const qCounts = { exact: 0, close: 0, miss: 0, CATASTROPHIC: 0 };
for (const { label } of quantRows) qCounts[label]++;
const qN = quantRows.length;
const within = qCounts.exact + qCounts.close;
const withinPct = qN ? (within / qN) * 100 : 0;
const cataPct = qN ? (qCounts.CATASTROPHIC / qN) * 100 : 0;

// per-category (by case.cat) pass counts — a quantity-mode row "passes" when
// exact|close (within tolerance); a predicate-mode row passes gradePredicate.
const byCat = {};
const bump = (cat, pass) => {
  byCat[cat] = byCat[cat] || { n: 0, pass: 0 };
  byCat[cat].n++;
  if (pass) byCat[cat].pass++;
};
for (const { row, label } of quantRows) bump(row.cat, label === 'exact' || label === 'close');
for (const { row, pass } of predRows) bump(row.cat, pass);

const predPass = predRows.filter((p) => p.pass).length;

// ---- report ----
const pct = (x) => `${x.toFixed(1)}%`;
console.log(`Graded ${rows.length} case(s) from ${FILE}\n`);

console.log('By category (within-tolerance / pass):');
for (const [cat, c] of Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${cat.padEnd(12)} ${c.pass}/${c.n}  (${pct((c.pass / c.n) * 100)})`);
}

console.log(`\nQuantity (band) cases: ${qN}`);
console.log(`  exact ${qCounts.exact}  close ${qCounts.close}  miss ${qCounts.miss}  CATASTROPHIC ${qCounts.CATASTROPHIC}`);
console.log(`  within tolerance (exact+close): ${within}/${qN}  (${pct(withinPct)})   [ship bar ~75%]`);
console.log(`  catastrophic:                   ${qCounts.CATASTROPHIC}/${qN}  (${pct(cataPct)})   [bar ~5%]`);

console.log(`\nRegression/spot cases: ${predRows.length}`);
console.log(`  pass: ${predPass}/${predRows.length}  (${pct(predRows.length ? (predPass / predRows.length) * 100 : 0)})`);

if (failLines.length) {
  console.log(`\nNon-exact / failing cases (${failLines.length}):`);
  for (const l of failLines) console.log(l);
} else {
  console.log('\nAll cases exact/passing.');
}

if (JSON_OUT) {
  const summary = {
    file: FILE,
    total: rows.length,
    quantity: {
      n: qN,
      exact: qCounts.exact,
      close: qCounts.close,
      miss: qCounts.miss,
      catastrophic: qCounts.CATASTROPHIC,
      within: within,
      withinPct: Number(withinPct.toFixed(2)),
      catastrophicPct: Number(cataPct.toFixed(2)),
    },
    predicate: {
      n: predRows.length,
      pass: predPass,
      fail: predRows.length - predPass,
    },
    byCat: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, { n: v.n, pass: v.pass }])),
    failures: [
      ...quantRows
        .filter((q) => q.label !== 'exact')
        .map((q) => ({ id: q.row.id, cat: q.row.cat, text: q.row.text, label: q.label, totalGrams: q.row.totalGrams ?? null, expect: q.row.expect })),
      ...predRows.filter((p) => !p.pass).map((p) => ({ id: p.row.id, cat: p.row.cat, text: p.row.text, label: 'FAIL', why: p.why })),
    ],
  };
  console.log('\n' + JSON.stringify(summary, null, 2));
}
