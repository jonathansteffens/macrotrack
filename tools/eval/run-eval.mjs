// Runs the estimator end-to-end against cases.jsonl and scores it: the model
// produces a FoodClaim, claims are resolved against foods.db exactly like the
// app does, and the resulting macros are compared to ground truth.
//
// This is the Phase 3 yardstick: run it per model/pipeline and compare.
//
//   node tools/eval/run-eval.mjs                       # claude-haiku-4-5
//   node tools/eval/run-eval.mjs --model claude-opus-4-8
//
// Requires ANTHROPIC_API_KEY. Install deps once: cd tools && npm install

import Anthropic from '@anthropic-ai/sdk';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const modelArg = process.argv.indexOf('--model');
const MODEL = modelArg > -1 ? process.argv[modelArg + 1] : 'claude-haiku-4-5';

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
  return db
    .prepare(
      `SELECT name, kcal, protein, carbs, fat FROM foods WHERE ${where}
       ORDER BY CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT 1`
    )
    .get(...params, prefix);
}

function resolveClaim(claim) {
  return claim.items.map((item) => {
    let food = null;
    for (const term of [...item.db_search_terms, item.name]) {
      food = search(term);
      if (food) break;
    }
    const per100 = food ?? item.est_per100;
    const f = item.grams / 100;
    return {
      name: item.name,
      grams: item.grams,
      matched: food?.name ?? null,
      kcal: per100.kcal * f,
      protein: (per100.protein ?? 0) * f,
      carbs: (per100.carbs ?? 0) * f,
      fat: (per100.fat ?? 0) * f,
    };
  });
}

// ---- Run ----

const client = new Anthropic();
const cases = readFileSync(join(HERE, 'cases.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

console.log(`Model: ${MODEL} — ${cases.length} cases\n`);

const rows = [];
for (const c of cases) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: c.text }],
  });
  const text = response.content.find((b) => b.type === 'text')?.text;
  const claim = JSON.parse(text);
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
  const row = {
    id: c.id,
    kcalExp: c.expected.kcal,
    kcalPred: pred.kcal,
    kcalApe: Math.abs(pred.kcal - c.expected.kcal) / c.expected.kcal,
    proteinErr: Math.abs(pred.protein - c.expected.protein),
    items: claim.items.length,
    itemsExp: c.n_items,
    matched: resolved.filter((r) => r.matched).length,
    asked: claim.needs_clarification,
  };
  rows.push(row);
  console.log(
    `${row.id.padEnd(20)} kcal ${String(Math.round(row.kcalPred)).padStart(4)} / ${String(Math.round(row.kcalExp)).padStart(4)} ` +
      `(${(row.kcalApe * 100).toFixed(0).padStart(3)}%)  P err ${row.proteinErr.toFixed(1).padStart(5)} g  ` +
      `items ${row.items}/${row.itemsExp}  matched ${row.matched}/${row.items}${row.asked ? '  [asked]' : ''}`
  );
}

const mean = (sel) => rows.reduce((s, r) => s + sel(r), 0) / rows.length;
console.log('\n──── Summary ────');
console.log(`kcal MAPE:            ${(mean((r) => r.kcalApe) * 100).toFixed(1)}%`);
console.log(`protein MAE:          ${mean((r) => r.proteinErr).toFixed(1)} g`);
console.log(
  `item count accuracy:  ${((rows.filter((r) => r.items === r.itemsExp).length / rows.length) * 100).toFixed(0)}%`
);
console.log(
  `DB match rate:        ${((rows.reduce((s, r) => s + r.matched, 0) / rows.reduce((s, r) => s + r.items, 0)) * 100).toFixed(0)}%`
);
console.log(
  `clarification rate:   ${((rows.filter((r) => r.asked).length / rows.length) * 100).toFixed(0)}%  (these cases are unambiguous — lower is better)`
);
