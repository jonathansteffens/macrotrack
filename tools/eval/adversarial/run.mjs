// Adversarial eval harness: runs the case list in ./cases.mjs against any
// OpenAI-compatible chat completions endpoint (llama-server, vllm, sglang,
// a hosted API, ...) and resolves each response the same way the app would
// (count x unit_grams, branded-serving snap, DB lookup), so grams/macro
// totals are comparable to the `expect` bands in the case list.
//
// Born from the v6 QA gate -- a one-off pre-release harness run once against
// the v6 model revision -- and promoted here as a permanent eval tier so
// future revisions can be checked against the same 151 cases. Prompt/schema
// are extracted live from the repo (no drift); search()/seedGrams() are
// copied VERBATIM from tools/eval/run-eval.mjs (the resolver logic that
// implements the count x unit_grams multiplication schema v2 exists for).
// Read-only against the repo.
//
//   node tools/eval/adversarial/run.mjs [--base-url http://127.0.0.1:8047/v1] \
//     [--model <name>] [--out results.json] [--concurrency 6] \
//     [--limit N] [--ids <file-of-case-ids.json>]
//
//   node tools/eval/adversarial/run.mjs --list   # case counts per category, no server needed
//   node tools/eval/adversarial/run.mjs --help

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';

// Resolved relative to this script, not the caller's cwd or a hardcoded
// checkout path -- tools/eval/adversarial/ -> repo root is 3 levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const BASE_URL = arg('base-url', 'http://127.0.0.1:8047/v1');
const MODEL = arg('model', 'estimator');
const OUT = arg('out', 'results.json');
const CONCURRENCY = parseInt(arg('concurrency', '6'), 10);
const LIMIT = arg('limit', null);
const IDS_FILE = arg('ids', null);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node tools/eval/adversarial/run.mjs [--base-url http://127.0.0.1:8047/v1] [--model <name>] [--out results.json] [--concurrency 6] [--limit N] [--ids <file>] [--list]`);
  console.log(`  --list   print case counts per category and exit (no live model server needed)`);
  process.exit(0);
}

// ---- Prompt + schema straight from the app (byte-identical to what ships) ----
const promptSrc = readFileSync(join(ROOT, 'mobile', 'src', 'lib', 'ai', 'prompt.ts'), 'utf8');
const SYSTEM_PROMPT = promptSrc.match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
const schemaSrc = readFileSync(join(ROOT, 'mobile', 'src', 'lib', 'ai', 'schema.ts'), 'utf8');
const SCHEMA = new Function(`return (${schemaSrc.match(/FOOD_CLAIM_SCHEMA = ({[\s\S]*?}) as const;/)[1]});`)();

// ---- DB resolution: verbatim copy of tools/eval/run-eval.mjs ----
const db = new DatabaseSync(join(ROOT, 'mobile', 'assets', 'foods.db'), { readOnly: true });
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query, col = 'name_norm') {
  const all = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (!tokens.length) return null;
  const where = tokens.map(() => `(' ' || ${col}) LIKE ? ESCAPE '\\'`).join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  const prefix = `${tokens[0]}%`;
  const wholeWord = `% ${tokens[0].replace(/[\\%_]/g, (c) => '\\' + c)} %`;
  // col is name_norm for the primary pass, display_name_norm for the strict-
  // superset fallback (guarded to rows that actually have a display name).
  const guard = col === 'display_name_norm' ? 'AND display_name_norm IS NOT NULL' : '';
  return db
    .prepare(
      `SELECT name, name_norm, kcal, protein, carbs, fat, data_type, portions_json FROM foods WHERE ${where} ${guard}
       ORDER BY CASE WHEN (' ' || ${col} || ' ') LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                CASE WHEN ${col} LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(${col}) LIMIT 1`
    )
    .get(...params, wholeWord, prefix);
}

// countInName / COUNT_WORDS / seedGrams below are kept in sync with
// tools/eval/run-eval.mjs (verbatim). The v7 QA gate found this copy had
// drifted — it was missing the count===1 countInName max() rescue, so the
// "fake branded SKU" stopgap was absent here; re-synced with run-eval.mjs.
const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
function countInName(name) {
  const m = /^(\d{1,2})\s+/.exec((name || '').trim());
  if (m) return Math.min(24, parseInt(m[1], 10)) || null;
  return COUNT_WORDS[(name || '').trim().toLowerCase().split(/\s+/)[0]] ?? null;
}

// ---- Branded corroboration guard — keep IN SYNC across resolver.ts,
//   tools/eval/run-eval.mjs, tools/chat/playground.mjs,
//   tools/eval/adversarial/run.mjs ----
// A single generic search token can whole-word match a branded row by accident
// ("oreo" → "Dairy Queen Royal Oreo Blizzard"); branded serving-scaling would
// then multiply the model's count by that row's ~350 g serving ("4 oreos" →
// 1400 g / 4200 kcal). So branded serving-scaling applies ONLY when the match
// is CORROBORATED by the model's own words: it named the row's brand/chain, OR
// it named every one of the row's distinctive (product-identity) tokens.
// COMMON_BRAND_TOKENS = tokens in ≥ COMMON_DF_MIN branded name_norms — chain
// names (dairy, queen, burger, king, …) plus generic food words (sandwich,
// cheese, …); everything rarer is a distinctive token (baconator, whopper,
// blizzard, big, mac, …). Derived once from the bundled foods.db.
const COMMON_DF_MIN = 20;
function corrTokens(s) {
  return (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
const COMMON_BRAND_TOKENS = (() => {
  const rows = db.prepare("SELECT name_norm FROM foods WHERE data_type = 'branded'").all();
  const df = new Map();
  for (const r of rows) for (const t of new Set(corrTokens(r.name_norm))) df.set(t, (df.get(t) || 0) + 1);
  const set = new Set();
  for (const [t, n] of df) if (n >= COMMON_DF_MIN) set.add(t);
  return set;
})();
function brandedCorroborated(item, rowNameNorm) {
  const modelToks = new Set([item.name, ...(item.db_search_terms || [])].flatMap(corrTokens));
  const rowToks = [...new Set(corrTokens(rowNameNorm))];
  const distinctive = rowToks.filter((t) => !COMMON_BRAND_TOKENS.has(t));
  const common = rowToks.filter((t) => COMMON_BRAND_TOKENS.has(t));
  const namedBrand = common.length > 0 && common.every((t) => modelToks.has(t));
  const namedProduct = distinctive.length > 0 && distinctive.every((t) => modelToks.has(t));
  return namedBrand || namedProduct;
}

function seedGrams(item, food) {
  // Branded serving-scaling only when the model's words corroborate the match
  // (see brandedCorroborated) — an uncorroborated branded row is a coincidental
  // token collision, so keep the model's own grams instead of snapping.
  const branded = food?.data_type === 'branded' && brandedCorroborated(item, food.name_norm);
  // Multi-portion rows: label match to the claim name, then closest grams.
  let brandedServing;
  if (branded) {
    const portions = JSON.parse(food.portions_json || '[]').filter((p) => p.grams > 0);
    const toks = (item.name || '').toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const sc = (l) => toks.filter((t) => (l || '').toLowerCase().includes(t)).length;
    brandedServing = portions.sort((a, b) => sc(b.label) - sc(a.label) || Math.abs(a.grams - item.grams) - Math.abs(b.grams - item.grams))[0]?.grams;
  }
  // v2 count preference (mirrors resolver.ts seedGrams): whole-unit count ×
  // per-unit serving (branded DB serving, else unit_grams, else grams/count).
  if (typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0) {
    // Stopgap for the "fake branded SKU" emission {name:"2 big mac", count:1}:
    // count stuck at 1 but the real count baked into the name — trust the
    // larger; a genuine count > 1 is untouched. (mirrors resolver.ts,
    // playground.mjs seedGrams — keep the three in sync.)
    const effCount = item.count === 1 ? Math.max(item.count, countInName(item.name) ?? 1) : item.count;
    const count = Math.min(24, Math.max(0.25, effCount));
    const serving = brandedServing && brandedServing > 0
      ? brandedServing
      : item.unit_grams && item.unit_grams > 0 ? item.unit_grams : item.grams / item.count;
    return Math.round(count * serving);
  }
  if (!branded) return item.grams;
  if (!brandedServing || brandedServing <= 0) return item.grams;
  const explicit = countInName(item.name);
  const plural = /s$/i.test((item.name || '').trim());
  const count = explicit ?? (plural ? Math.min(24, Math.max(1, Math.round(item.grams / brandedServing))) : 1);
  return count * brandedServing;
}

function resolveClaim(claim) {
  return claim.items.map((item) => {
    let food = null;
    for (const term of [...(item.db_search_terms || []), item.name]) {
      food = search(term);
      if (food) break;
    }
    // Stage 2 (STRICT SUPERSET) — only when name_norm matched NOTHING for every
    // term do we retry against the plain-language display_name_norm, so no
    // existing resolution can change (mirrors resolver.ts resolveItem; in sync
    // with tools/eval/run-eval.mjs and tools/chat/playground.mjs).
    if (!food) {
      for (const term of [...(item.db_search_terms || []), item.name]) {
        food = search(term, 'display_name_norm');
        if (food) break;
      }
    }
    const per100 = food ?? item.est_per100;
    const grams = seedGrams(item, food);
    const f = grams / 100;
    return {
      name: item.name,
      rawCount: item.count,
      rawUnitGrams: item.unit_grams,
      rawGrams: item.grams,
      resolvedGrams: grams,
      matched: food?.name ?? null,
      dataType: food?.data_type ?? null,
      kcal: (per100.kcal ?? 0) * f,
      protein: (per100.protein ?? 0) * f,
      carbs: (per100.carbs ?? 0) * f,
      fat: (per100.fat ?? 0) * f,
    };
  });
}

async function ask(text, attempt = 0) {
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      temperature: attempt === 0 ? 0 : 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'food_claim', strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}

async function runCase(c) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await ask(c.text, attempt);
      let claim;
      try {
        claim = JSON.parse(text);
      } catch {
        return { ...c, invalid: true, raw: String(text).slice(0, 500) };
      }
      const resolved = resolveClaim(claim);
      const totalGrams = resolved.reduce((s, r) => s + r.resolvedGrams, 0);
      const totals = resolved.reduce(
        (s, r) => ({ kcal: s.kcal + r.kcal, protein: s.protein + r.protein, carbs: s.carbs + r.carbs, fat: s.fat + r.fat }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0 }
      );
      return {
        ...c,
        meal_guess: claim.meal_guess,
        needs_clarification: claim.needs_clarification,
        questions: claim.questions,
        rawItems: claim.items,
        resolved,
        totalGrams,
        totals,
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { ...c, error: String(lastErr).slice(0, 300) };
}

let RUN_CASES = CASES;
if (IDS_FILE) {
  const ids = new Set(JSON.parse(readFileSync(IDS_FILE, 'utf8')));
  RUN_CASES = CASES.filter((c) => ids.has(c.id));
} else if (LIMIT) {
  RUN_CASES = CASES.slice(0, parseInt(LIMIT, 10));
}

// Dry-run mode: no live model server touched, just a manifest of what would run.
if (process.argv.includes('--list')) {
  const byCat = {};
  for (const c of RUN_CASES) byCat[c.cat] = (byCat[c.cat] ?? 0) + 1;
  console.log(`${RUN_CASES.length} case(s) total`);
  for (const [cat, n] of Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${cat}: ${n}`);
  }
  process.exit(0);
}

const rows = new Array(RUN_CASES.length);
let next = 0;
async function worker() {
  while (next < RUN_CASES.length) {
    const i = next++;
    rows[i] = await runCase(RUN_CASES[i]);
    const r = rows[i];
    console.log(`${r.error ? 'ERR ' : r.invalid ? 'BAD ' : 'ok  '}${r.id}`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`\nWrote ${rows.length} rows to ${OUT}`);
console.log(`Errors: ${rows.filter((r) => r.error).length}, Invalid JSON: ${rows.filter((r) => r.invalid).length}`);
