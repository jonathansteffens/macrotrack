// Robustness probe for the local estimator: sends messy / out-of-distribution
// / adversarial free-text meals (typos, vague portions, unusual cuisines,
// non-food, odd quantities) through the REAL system prompt + FoodClaim grammar
// and prints each claim compactly. No ground truth — this is a "does it stay
// reliable off-distribution" eyeball, complementing the scored cases.jsonl.
//
//   node tools/eval/robustness-check.mjs --base-url http://127.0.0.1:8036/v1
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const BASE_URL = arg('base-url', 'http://127.0.0.1:8036/v1');
const MODEL = arg('model', 'local');

const src = readFileSync(join(HERE, '..', '..', 'mobile', 'src', 'lib', 'ai', 'prompt.ts'), 'utf8');
const SYSTEM_PROMPT = src.match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
const ss = readFileSync(join(HERE, '..', '..', 'mobile', 'src', 'lib', 'ai', 'schema.ts'), 'utf8');
const SCHEMA = new Function(`return (${ss.match(/FOOD_CLAIM_SCHEMA = ({[\s\S]*?}) as const;/)[1]});`)();

const INPUTS = [
  // typos / txt-speak
  '2 egs and tost with buttr',
  'chikn brest w a cup of rice',
  // vague
  'lunch',
  'some food earlier',
  'a snack',
  // unusual / OOD cuisines not in the food pools
  'a bowl of pho with beef',
  'chicken tikka masala with naan',
  'two california sushi rolls',
  'a bahn mi sandwich',
  'pad thai with shrimp',
  // compound / large
  'for dinner I had a bacon cheeseburger, large fries, a chocolate milkshake, and a side caesar salad',
  // odd quantities / phrasing
  'half a large pepperoni pizza',
  'about 500 calories of grilled chicken',
  'three quarters of a cup of oatmeal with a drizzle of honey',
  // adversarial / non-food / empty-ish
  'my car keys',
  '???',
  'I did not eat anything',
  // brand / packaged
  'a protein bar and a monster energy drink',
  'mcdonalds big mac meal',
];

async function ask(text) {
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, temperature: 0,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }],
      response_format: { type: 'json_schema', json_schema: { name: 'food_claim', strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const c = (await res.json()).choices?.[0]?.message?.content;
  try { return { claim: JSON.parse(c) }; } catch { return { invalid: String(c).slice(0, 120) }; }
}

let valid = 0;
for (const text of INPUTS) {
  const r = await ask(text);
  if (r.claim) {
    valid++;
    const c = r.claim;
    const items = c.items.map((i) => `${i.name} ${i.grams}g`).join(', ') || '(none)';
    const q = c.needs_clarification ? `  ASK:[${c.questions.join(' | ')}]` : '';
    console.log(`✔ "${text}"\n    → [${c.meal_guess}] ${items}${q}`);
  } else {
    console.log(`✗ "${text}"\n    → ${r.error || 'INVALID: ' + r.invalid}`);
  }
}
console.log(`\nvalid JSON: ${valid}/${INPUTS.length}`);
