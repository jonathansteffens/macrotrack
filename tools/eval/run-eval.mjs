// Runs the estimator end-to-end against cases.jsonl and scores it: the model
// produces a FoodClaim, claims are resolved against foods.db exactly like the
// app does, and the resulting macros are compared to ground truth.
//
// This is the Phase 3 yardstick: run it per model/pipeline and compare.
//
//   node tools/eval/run-eval.mjs                             # claude-haiku-4-5
//   node tools/eval/run-eval.mjs --model claude-opus-4-8
//   node tools/eval/run-eval.mjs --base-url http://127.0.0.1:8033/v1 --model local
//
// --base-url switches to any OpenAI-compatible /chat/completions endpoint
// (llama.cpp llama-server, vLLM, sglang). The FoodClaim schema is sent as
// response_format json_schema — llama-server compiles it to a GBNF grammar,
// which is exactly how the app will constrain llama.rn on device.
//
// Other flags:
//   --cases <file>        cases file (default tools/eval/cases.jsonl)
//   --out <file>          write full results as JSON (for runs/ logging)
//   --concurrency <n>     parallel requests (default 1; local servers only)
//   --api-key <key>       bearer token for --base-url endpoints (optional)
//
// Anthropic mode requires ANTHROPIC_API_KEY. Install deps once: cd tools && npm install

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const MODEL = arg('model', 'claude-haiku-4-5');
const BASE_URL = arg('base-url', null);
const CASES_FILE = arg('cases', join(HERE, 'cases.jsonl'));
const OUT = arg('out', null);
const CONCURRENCY = parseInt(arg('concurrency', '1'), 10);
const API_KEY = arg('api-key', process.env.OPENAI_API_KEY ?? 'none');

// ---- Prompt + schema: keep in sync with mobile/src/lib/ai/{prompt,schema}.ts ----

const SYSTEM_PROMPT = readPromptFromApp();
const SCHEMA = readSchemaFromApp();

function readPromptFromApp() {
  // The app stores the prompt as a single template literal — extract it so
  // the eval always tests the shipped prompt (no drift).
  const src = readFileSync(
    join(HERE, '..', '..', 'mobile', 'src', 'lib', 'ai', 'prompt.ts'),
    'utf8'
  );
  const match = src.match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!match) throw new Error('Could not extract ESTIMATOR_SYSTEM_PROMPT from prompt.ts');
  return match[1];
}

function readSchemaFromApp() {
  const src = readFileSync(
    join(HERE, '..', '..', 'mobile', 'src', 'lib', 'ai', 'schema.ts'),
    'utf8'
  );
  const match = src.match(/FOOD_CLAIM_SCHEMA = ({[\s\S]*?}) as const;/);
  if (!match) throw new Error('Could not extract FOOD_CLAIM_SCHEMA from schema.ts');
  // The schema literal is valid JSON except for unquoted keys — eval it.
  return new Function(`return (${match[1]});`)();
}

// ---- Resolution: same search SQL as mobile/src/lib/foods.ts ----

const db = new DatabaseSync(join(HERE, '..', '..', 'mobile', 'assets', 'foods.db'), {
  readOnly: true,
});

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query) {
  const all = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (!tokens.length) return null;
  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  const prefix = `${tokens[0]}%`;
  const wholeWord = `% ${tokens[0].replace(/[\\%_]/g, (c) => '\\' + c)} %`;
  // Mirrors mobile/src/lib/foods.ts 'all' scope: whole-word first-token match
  // outranks substring matches, then prefix, then shortest name.
  return db
    .prepare(
      `SELECT name, kcal, protein, carbs, fat, data_type, portions_json FROM foods WHERE ${where}
       ORDER BY CASE WHEN (' ' || name_norm || ' ') LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT 1`
    )
    .get(...params, wholeWord, prefix);
}

// Mirrors resolver.ts seedGrams: branded → whole servings (explicit count in
// the item name wins, plural snaps model grams to a count, else 1 item).
const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
function countInName(name) {
  const m = /^(\d{1,2})\s+/.exec((name || '').trim());
  if (m) return Math.min(24, parseInt(m[1], 10)) || null;
  return COUNT_WORDS[(name || '').trim().toLowerCase().split(/\s+/)[0]] ?? null;
}
function seedGrams(item, food) {
  const branded = food?.data_type === 'branded';
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
    for (const term of [...item.db_search_terms, item.name]) {
      food = search(term);
      if (food) break;
    }
    const per100 = food ?? item.est_per100;
    const grams = seedGrams(item, food);
    const f = grams / 100;
    return {
      name: item.name,
      grams,
      matched: food?.name ?? null,
      kcal: per100.kcal * f,
      protein: (per100.protein ?? 0) * f,
      carbs: (per100.carbs ?? 0) * f,
      fat: (per100.fat ?? 0) * f,
    };
  });
}

// ---- Model calls: Anthropic or any OpenAI-compatible endpoint ----

async function callAnthropic(client, text) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: text }],
  });
  return response.content.find((b) => b.type === 'text')?.text;
}

async function callOpenAI(text, attempt = 0) {
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // retries jitter the temperature so a deterministic server-side failure
      // (e.g. grammar-stack edge cases) can take a different path
      temperature: attempt === 0 ? 0 : 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'food_claim', strict: true, schema: SCHEMA },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}

async function runCase(client, c) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = BASE_URL ? await callOpenAI(c.text, attempt) : await callAnthropic(client, c.text);
      let claim;
      try {
        claim = JSON.parse(text);
      } catch {
        return { id: c.id, valid: false, raw: String(text).slice(0, 500) };
      }
      const resolved = resolveClaim(claim);
      const pred = resolved.reduce(
        (s, r) => ({
          kcal: s.kcal + r.kcal,
          protein: s.protein + r.protein,
          carbs: s.carbs + r.carbs,
          fat: s.fat + r.fat,
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0 }
      );
      return {
        id: c.id,
        valid: true,
        kcalExp: c.expected.kcal,
        kcalPred: pred.kcal,
        kcalApe: Math.abs(pred.kcal - c.expected.kcal) / c.expected.kcal,
        proteinErr: Math.abs(pred.protein - c.expected.protein),
        items: claim.items.length,
        itemsExp: c.n_items,
        matched: resolved.filter((r) => r.matched).length,
        asked: claim.needs_clarification,
        claim,
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  console.error(`Case ${c.id} failed after retries (${String(lastErr).slice(0, 120)}) — scored invalid`);
  return { id: c.id, valid: false, error: String(lastErr).slice(0, 300) };
}

// ---- Run ----

let client = null;
if (!BASE_URL) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (or pass --base-url for a local endpoint).');
    process.exit(1);
  }
  client = new Anthropic();
}

const cases = readFileSync(CASES_FILE, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

console.log(`Model: ${MODEL}${BASE_URL ? ` @ ${BASE_URL}` : ''} — ${cases.length} cases\n`);

const rows = new Array(cases.length);
let next = 0;
async function worker() {
  while (next < cases.length) {
    const i = next++;
    const row = await runCase(client, cases[i]);
    rows[i] = row;
    if (!row.valid) {
      console.log(`${row.id.padEnd(24)} INVALID JSON`);
      continue;
    }
    console.log(
      `${row.id.padEnd(24)} kcal ${String(Math.round(row.kcalPred)).padStart(4)} / ${String(Math.round(row.kcalExp)).padStart(4)} ` +
        `(${(row.kcalApe * 100).toFixed(0).padStart(3)}%)  P err ${row.proteinErr.toFixed(1).padStart(5)} g  ` +
        `items ${row.items}/${row.itemsExp}  matched ${row.matched}/${row.items}${row.asked ? '  [asked]' : ''}`
    );
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

const ok = rows.filter((r) => r.valid);
const mean = (sel) => ok.reduce((s, r) => s + sel(r), 0) / ok.length;
const summary = {
  model: MODEL,
  baseUrl: BASE_URL,
  cases: cases.length,
  jsonValidity: ok.length / rows.length,
  kcalMape: mean((r) => r.kcalApe),
  proteinMae: mean((r) => r.proteinErr),
  itemCountAcc: ok.filter((r) => r.items === r.itemsExp).length / ok.length,
  dbMatchRate: ok.reduce((s, r) => s + r.matched, 0) / ok.reduce((s, r) => s + r.items, 0),
  clarificationRate: ok.filter((r) => r.asked).length / ok.length,
};

console.log('\n──── Summary ────');
console.log(`JSON validity:        ${(summary.jsonValidity * 100).toFixed(0)}%`);
console.log(`kcal MAPE:            ${(summary.kcalMape * 100).toFixed(1)}%`);
console.log(`protein MAE:          ${summary.proteinMae.toFixed(1)} g`);
console.log(`item count accuracy:  ${(summary.itemCountAcc * 100).toFixed(0)}%`);
console.log(`DB match rate:        ${(summary.dbMatchRate * 100).toFixed(0)}%`);
console.log(
  `clarification rate:   ${(summary.clarificationRate * 100).toFixed(0)}%  (these cases are unambiguous — lower is better)`
);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2) + '\n');
  console.log(`\nWrote ${OUT}`);
}
