// Scores photo→FoodClaim on the Nutrition5k OFFICIAL test split against
// measured dish totals, through any OpenAI-compatible endpoint that accepts
// base64 image_url content (llama.cpp llama-server with --mmproj).
//
//   node tools/eval/run-eval-n5k.mjs --base-url http://127.0.0.1:8033/v1 \
//     [--cases data/nutrition5k/n5k-test.jsonl] [--limit 200] [--concurrency 2] \
//     [--model name] [--out runs/<x>/n5k.json]
//
// The claim is resolved against foods.db exactly like the app (db_search_terms
// first, est_per100 fallback), so this measures end-to-end app behavior.
// Reference: the Nutrition5k paper's direct-regression baseline is
// 70.6 kcal / 26.1% caloric MAE on this split (arxiv 2103.03375, Table 2).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE_URL = arg('base-url', null);
if (!BASE_URL) {
  console.error('--base-url is required (llama-server needs --mmproj for images)');
  process.exit(2);
}
const MODEL = arg('model', 'local');
const CASES_FILE = arg('cases', join(ROOT, 'data', 'nutrition5k', 'n5k-test.jsonl'));
const LIMIT = parseInt(arg('limit', '0'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '2'), 10);
const OUT = arg('out', null);

// ---- Prompt + schema extracted from the app (no drift) ----
const SYSTEM_PROMPT = readFileSync(join(ROOT, 'mobile', 'src', 'lib', 'ai', 'prompt.ts'), 'utf8')
  .match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
const SCHEMA = new Function(
  `return (${readFileSync(join(ROOT, 'mobile', 'src', 'lib', 'ai', 'schema.ts'), 'utf8')
    .match(/FOOD_CLAIM_SCHEMA = ({[\s\S]*?}) as const;/)[1]});`
)();

// ---- Resolution: same search SQL as mobile/src/lib/foods.ts ----
const db = new DatabaseSync(join(ROOT, 'mobile', 'assets', 'foods.db'), { readOnly: true });
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (!tokens.length) return null;
  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  return db
    .prepare(
      `SELECT name, kcal, protein, carbs, fat FROM foods WHERE ${where}
       ORDER BY CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT 1`
    )
    .get(...params, `${tokens[0]}%`);
}

function resolveClaim(claim) {
  return claim.items.map((item) => {
    let food = null;
    for (const term of [...(item.db_search_terms ?? []), item.name]) {
      food = search(term);
      if (food) break;
    }
    const per100 = food ?? item.est_per100;
    const f = item.grams / 100;
    return {
      grams: item.grams,
      kcal: per100.kcal * f,
      protein: (per100.protein ?? 0) * f,
      carbs: (per100.carbs ?? 0) * f,
      fat: (per100.fat ?? 0) * f,
    };
  });
}

// ---- Run ----
let cases = readFileSync(CASES_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
if (LIMIT > 0) cases = cases.slice(0, LIMIT);
console.log(`Nutrition5k test split: ${cases.length} dishes via ${BASE_URL} (${MODEL})\n`);

async function runCase(c) {
  const img = readFileSync(join(ROOT, c.image)).toString('base64');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer none' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          // retries jitter the temperature so a deterministic server-side
          // failure (e.g. grammar-stack edge cases) can take a different path
          temperature: attempt === 0 ? 0 : 0.3,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } },
                { type: 'text', text: 'Estimate the nutrition of this meal.' },
              ],
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'food_claim', strict: true, schema: SCHEMA },
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const text = (await res.json()).choices?.[0]?.message?.content;
      let claim;
      try {
        claim = JSON.parse(text);
      } catch {
        return { id: c.dish_id, valid: false };
      }
      const resolved = resolveClaim(claim);
      const pred = resolved.reduce(
        (s, r) => ({ kcal: s.kcal + r.kcal, protein: s.protein + r.protein, mass: s.mass + r.grams }),
        { kcal: 0, protein: 0, mass: 0 }
      );
      return {
        id: c.dish_id,
        valid: true,
        kcalTrue: c.totals.kcal,
        kcalPred: pred.kcal,
        proteinTrue: c.totals.protein,
        proteinPred: pred.protein,
        massTrue: c.totals.mass,
        massPred: pred.mass,
        items: claim.items.length,
        asked: claim.needs_clarification,
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  console.error(`dish ${c.dish_id} failed after retries (${String(lastErr).slice(0, 120)}) — scored invalid`);
  return { id: c.dish_id, valid: false };
}

const rows = new Array(cases.length);
let next = 0;
let done = 0;
async function worker() {
  while (next < cases.length) {
    const i = next++;
    rows[i] = await runCase(cases[i]);
    if (++done % 25 === 0) console.log(`  ${done}/${cases.length}`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

const ok = rows.filter((r) => r.valid);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const kcalMae = mean(ok.map((r) => Math.abs(r.kcalPred - r.kcalTrue)));
const meanTrueKcal = mean(ok.map((r) => r.kcalTrue));
const proteinMae = mean(ok.map((r) => Math.abs(r.proteinPred - r.proteinTrue)));
const meanTrueProtein = mean(ok.map((r) => r.proteinTrue));
const massMae = mean(ok.map((r) => Math.abs(r.massPred - r.massTrue)));
const meanTrueMass = mean(ok.map((r) => r.massTrue));

const summary = {
  model: MODEL,
  baseUrl: BASE_URL,
  cases: cases.length,
  jsonValidity: ok.length / rows.length,
  kcalMae,
  kcalMaePct: kcalMae / meanTrueKcal,
  proteinMae,
  proteinMaePct: proteinMae / meanTrueProtein,
  massMae,
  massMaePct: massMae / meanTrueMass,
  clarificationRate: ok.filter((r) => r.asked).length / ok.length,
};

console.log('\n──── Nutrition5k test-split summary ────');
console.log(`JSON validity:   ${(summary.jsonValidity * 100).toFixed(0)}%`);
console.log(`caloric MAE:     ${kcalMae.toFixed(1)} kcal  (${(summary.kcalMaePct * 100).toFixed(1)}% of mean)   [paper baseline: 70.6 / 26.1%]`);
console.log(`protein MAE:     ${proteinMae.toFixed(1)} g     (${(summary.proteinMaePct * 100).toFixed(1)}% of mean)`);
console.log(`mass MAE:        ${massMae.toFixed(1)} g    (${(summary.massMaePct * 100).toFixed(1)}% of mean)`);
console.log(`clarification:   ${(summary.clarificationRate * 100).toFixed(0)}%`);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2) + '\n');
  console.log(`\nWrote ${OUT}`);
}
