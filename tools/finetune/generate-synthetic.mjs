// Generates synthetic text-entry SFT data for the local estimator model.
//
// The trick that makes labels free: meals are COMPOSED from foods.db, so the
// gold FoodClaim (foods, exact grams, per-100g macros, USDA search terms) is
// known by construction — no teacher model needed for ground truth. A share
// of samples renders quantities vaguely and carries a gold clarifying
// question, teaching the ask-vs-don't-ask policy.
//
//   node tools/finetune/generate-synthetic.mjs --n 2000 --seed 7 --out tools/finetune/sft-text.jsonl
//   node tools/finetune/generate-synthetic.mjs --n 500 --paraphrase   # rewrite texts with Haiku (needs ANTHROPIC_API_KEY)
//
// Output: JSONL, one {messages:[system,user,assistant]} per line (OpenAI chat
// format — accepted by Unsloth / LLaMA-Factory / TRL). The system prompt is
// extracted from the app so training matches inference exactly.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const N = parseInt(arg('n', '500'), 10);
const SEED = parseInt(arg('seed', '1'), 10);
const OUT = arg('out', join(HERE, 'sft-text.jsonl'));
const PARAPHRASE = process.argv.includes('--paraphrase');

// Deterministic RNG (mulberry32) so datasets are reproducible
let s = SEED >>> 0;
const rand = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const randInt = (min, max) => Math.floor(min + rand() * (max - min + 1));

// ---- System prompt from the app (no drift) ----
const SYSTEM_PROMPT = readFileSync(
  join(HERE, '..', '..', 'mobile', 'src', 'lib', 'ai', 'prompt.ts'),
  'utf8'
).match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

// ---- Food pools ----
// q: USDA-style query (resolved against foods.db, fails loudly if missing)
// name: how a user would say it
// units: ways to phrase an amount → grams. kind 'g' renders as grams;
//        'count'/'measure' render as household units.
const POOLS = {
  protein: [
    { q: 'chicken breast meat only roasted', name: 'roasted chicken breast', units: [{ kind: 'g', min: 100, max: 250 }, { kind: 'count', unit: 'small chicken breast', g: 140, min: 1, max: 2 }] },
    { q: 'beef ground 85 lean meat 15 fat patty cooked broiled', name: 'grilled beef patty', units: [{ kind: 'count', unit: 'patty', g: 90, min: 1, max: 2 }] },
    { q: 'salmon atlantic farmed cooked dry heat', name: 'cooked salmon', units: [{ kind: 'g', min: 100, max: 200 }, { kind: 'count', unit: 'fillet', g: 150, min: 1, max: 1 }] },
    { q: 'egg whole cooked scrambled', name: 'scrambled eggs', units: [{ kind: 'count', unit: 'egg', g: 61, min: 1, max: 4 }] },
    { q: 'egg whole cooked hard boiled', name: 'hard-boiled eggs', units: [{ kind: 'count', unit: 'egg', g: 50, min: 1, max: 3 }] },
    { q: 'tuna light canned water drained', name: 'canned tuna', units: [{ kind: 'count', unit: 'can', g: 140, min: 1, max: 1 }, { kind: 'g', min: 80, max: 160 }] },
    { q: 'pork chop loin boneless cooked broiled', name: 'grilled pork chop', units: [{ kind: 'count', unit: 'chop', g: 150, min: 1, max: 1 }] },
    { q: 'tofu firm', name: 'firm tofu', units: [{ kind: 'g', min: 80, max: 200 }] },
  ],
  starch: [
    { q: 'rice white long grain regular enriched cooked', name: 'white rice', units: [{ kind: 'measure', unit: 'cup', g: 160, fractions: true }] },
    { q: 'rice brown long grain cooked', name: 'brown rice', units: [{ kind: 'measure', unit: 'cup', g: 195, fractions: true }] },
    { q: 'pasta cooked enriched without added salt', name: 'cooked pasta', units: [{ kind: 'measure', unit: 'cup', g: 140, fractions: true }] },
    { q: 'bread whole wheat commercially prepared toasted', name: 'whole wheat toast', units: [{ kind: 'count', unit: 'slice', g: 26, min: 1, max: 3 }] },
    { q: 'bread white commercially prepared', name: 'white bread', units: [{ kind: 'count', unit: 'slice', g: 27, min: 1, max: 3 }] },
    { q: 'potatoes baked flesh and skin', name: 'baked potato', units: [{ kind: 'count', unit: 'medium potato', g: 173, min: 1, max: 1 }] },
    { q: 'oats regular and quick cooked with water', name: 'cooked oatmeal', units: [{ kind: 'measure', unit: 'cup', g: 234, fractions: true }] },
    { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', units: [{ kind: 'count', unit: 'large tortilla', g: 70, min: 1, max: 2 }] },
    { q: 'quinoa cooked', name: 'cooked quinoa', units: [{ kind: 'measure', unit: 'cup', g: 185, fractions: true }] },
  ],
  vegetable: [
    { q: 'broccoli cooked boiled drained without salt', name: 'steamed broccoli', units: [{ kind: 'measure', unit: 'cup', g: 156, fractions: true }] },
    { q: 'carrots raw', name: 'baby carrots', units: [{ kind: 'g', min: 50, max: 120 }] },
    { q: 'spinach raw', name: 'raw spinach', units: [{ kind: 'measure', unit: 'cup', g: 30, fractions: false }] },
    { q: 'beans black mature seeds cooked boiled', name: 'black beans', units: [{ kind: 'measure', unit: 'cup', g: 172, fractions: true }] },
    { q: 'lettuce cos or romaine raw', name: 'romaine lettuce', units: [{ kind: 'measure', unit: 'cup shredded', g: 47, fractions: false }] },
  ],
  fat: [
    { q: 'oil olive salad or cooking', name: 'olive oil', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }] },
    { q: 'butter salted', name: 'butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }] },
    { q: 'peanut butter smooth style with salt', name: 'peanut butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 16, fractions: false }] },
    { q: 'avocados raw all commercial varieties', name: 'avocado', units: [{ kind: 'count', unit: 'half avocado', g: 100, min: 1, max: 2 }] },
    { q: 'nuts almonds', name: 'almonds', units: [{ kind: 'g', min: 15, max: 45 }, { kind: 'count', unit: 'handful', g: 28, min: 1, max: 2 }] },
  ],
  fruit: [
    { q: 'bananas raw', name: 'banana', units: [{ kind: 'count', unit: 'medium banana', g: 118, min: 1, max: 2 }] },
    { q: 'apples raw skin', name: 'apple', units: [{ kind: 'count', unit: 'medium apple', g: 182, min: 1, max: 1 }] },
    { q: 'strawberries raw', name: 'strawberries', units: [{ kind: 'measure', unit: 'cup', g: 152, fractions: true }] },
    { q: 'blueberries raw', name: 'blueberries', units: [{ kind: 'measure', unit: 'cup', g: 148, fractions: true }] },
    { q: 'oranges raw all commercial varieties', name: 'orange', units: [{ kind: 'count', unit: 'medium orange', g: 131, min: 1, max: 1 }] },
  ],
  dairy: [
    { q: 'yogurt greek plain nonfat', name: 'plain nonfat greek yogurt', units: [{ kind: 'measure', unit: 'cup', g: 245, fractions: true }] },
    { q: 'milk reduced fat fluid 2', name: '2% milk', units: [{ kind: 'measure', unit: 'cup', g: 244, fractions: false }] },
    { q: 'cheese cheddar', name: 'cheddar cheese', units: [{ kind: 'g', min: 20, max: 60 }, { kind: 'count', unit: 'slice', g: 21, min: 1, max: 2 }] },
    { q: 'cheese cottage lowfat 2 milkfat', name: 'cottage cheese', units: [{ kind: 'measure', unit: 'cup', g: 226, fractions: true }] },
  ],
};

// Snackable fats only (peanut butter, avocado, almonds) — nobody snacks on
// a spoonful of olive oil
POOLS.snackfat = POOLS.fat.filter((f) =>
  ['peanut butter', 'avocado', 'almonds'].includes(f.name)
);

const MEAL_SHAPES = [
  { meal: 'breakfast', slots: [['protein', 'dairy'], ['starch', 'fruit']], prefix: ['for breakfast I had', 'breakfast:', 'this morning I ate'] },
  { meal: 'lunch', slots: [['protein'], ['starch', 'vegetable'], ['vegetable', 'fat', null]], prefix: ['for lunch:', 'lunch was', 'I had for lunch'] },
  { meal: 'dinner', slots: [['protein'], ['starch'], ['vegetable', null], ['fat', null]], prefix: ['dinner:', 'tonight I had', 'for dinner I ate'] },
  { meal: 'snack', slots: [['fruit', 'snackfat', 'dairy']], prefix: ['snack:', 'just ate', ''] },
];

// ---- Resolve pool foods against the DB (ground truth) ----
const db = new DatabaseSync(join(HERE, '..', '..', 'mobile', 'assets', 'foods.db'), { readOnly: true });
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  return db
    .prepare(
      `SELECT name, kcal, protein, carbs, fat FROM foods WHERE ${where}
       ORDER BY CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT 1`
    )
    .get(...params, `${tokens[0]}%`);
}

for (const pool of Object.values(POOLS)) {
  for (const item of pool) {
    item.food = search(item.q);
    if (!item.food) throw new Error(`Pool food not found in DB: "${item.q}"`);
  }
}

// ---- Rendering ----

const numberWords = ['zero', 'one', 'two', 'three', 'four'];
const FRACTION_PHRASES = [
  { phrase: 'half a', f: 0.5 },
  { phrase: 'a', f: 1 },
  { phrase: 'one and a half', f: 1.5 },
  { phrase: 'two', f: 2 },
];

function renderComponent(item, vague) {
  const unit = pick(item.units);
  if (vague) {
    const phrase = pick([`some ${item.name}`, `a serving of ${item.name}`, `a bit of ${item.name}`]);
    const mid = unit.kind === 'g' ? Math.round((unit.min + unit.max) / 2) : Math.round(unit.g * ((unit.min ?? 1) + (unit.max ?? 1)) / 2);
    return { phrase, grams: mid, vague: true };
  }
  if (unit.kind === 'g') {
    const g = randInt(unit.min, unit.max);
    return { phrase: `${g} ${pick(['g', 'grams'])} of ${item.name}`, grams: g };
  }
  if (unit.kind === 'count') {
    const n = randInt(unit.min, unit.max);
    const noun = n > 1 ? `${unit.unit}s` : unit.unit;
    // "two eggs" reads better than "two eggs of scrambled eggs"
    const phrase = item.name.includes(unit.unit.split(' ').pop())
      ? `${numberWords[n]} ${item.name === 'scrambled eggs' && n === 1 ? 'scrambled egg' : noun === 'eggs' ? `scrambled ${noun}` : noun}`
      : `${numberWords[n]} ${noun} of ${item.name}`;
    return { phrase, grams: n * unit.g };
  }
  // measure (cup / tablespoon)
  const fr = unit.fractions ? pick(FRACTION_PHRASES) : pick(FRACTION_PHRASES.filter((x) => x.f >= 1 && x.f !== 1.5));
  const noun = fr.f === 2 ? `${unit.unit}s` : unit.unit;
  return { phrase: `${fr.phrase} ${noun} of ${item.name}`, grams: Math.round(fr.f * unit.g) };
}

function makeSample() {
  const shape = pick(MEAL_SHAPES);
  const items = [];
  for (const slot of shape.slots) {
    const cat = pick(slot);
    if (cat == null) continue;
    const item = pick(POOLS[cat]);
    if (items.some((i) => i.item === item)) continue;
    items.push({ item, cat });
  }
  if (items.length === 0) items.push({ item: pick(POOLS.fruit), cat: 'fruit' });

  // ~15% of samples make one high-variance component vague → gold question
  const vagueIdx = rand() < 0.15 ? Math.floor(rand() * items.length) : -1;

  const rendered = items.map(({ item }, i) => ({
    item,
    ...renderComponent(item, i === vagueIdx),
  }));

  const prefix = pick(shape.prefix);
  const list = rendered.map((r) => r.phrase);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  const text = prefix ? `${prefix} ${joined}` : joined;

  const vague = rendered.find((r) => r.vague);
  const claim = {
    items: rendered.map((r) => ({
      name: r.item.name,
      grams: r.grams,
      prep: null,
      confidence: r.vague ? 0.5 : 0.95,
      db_search_terms: [r.item.q],
      est_per100: {
        kcal: Math.round(r.item.food.kcal * 10) / 10,
        protein: Math.round((r.item.food.protein ?? 0) * 10) / 10,
        carbs: Math.round((r.item.food.carbs ?? 0) * 10) / 10,
        fat: Math.round((r.item.food.fat ?? 0) * 10) / 10,
      },
    })),
    needs_clarification: !!vague,
    questions: vague
      ? [`Roughly how much ${vague.item.name} was it — in grams or typical servings?`]
      : [],
    meal_guess: shape.meal,
  };

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
      { role: 'assistant', content: JSON.stringify(claim) },
    ],
  };
}

// ---- Optional paraphrase pass (diversity; needs ANTHROPIC_API_KEY) ----

async function paraphraseAll(samples) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  console.log('Paraphrasing user texts with claude-haiku-4-5…');
  for (let i = 0; i < samples.length; i++) {
    const userMsg = samples[i].messages[1];
    const res = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system:
        'Rewrite the meal description the way a real person would casually type it into a food tracking app. Keep every food and every quantity exactly the same (same numbers, same units). Vary phrasing, order, and style. Reply with only the rewritten text.',
      messages: [{ role: 'user', content: userMsg.content }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text?.trim();
    if (text) userMsg.content = text;
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${samples.length}`);
  }
}

// ---- Main ----

const samples = Array.from({ length: N }, makeSample);
if (PARAPHRASE) await paraphraseAll(samples);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, samples.map((x) => JSON.stringify(x)).join('\n') + '\n');

const withQ = samples.filter((x) => JSON.parse(x.messages[2].content).needs_clarification).length;
console.log(`Wrote ${samples.length} samples to ${OUT}`);
console.log(`  with clarifying question: ${withQ} (${Math.round((withQ / samples.length) * 100)}%)`);
console.log('Example:');
console.log('  user:', JSON.parse(samples[0].messages[1].content ? JSON.stringify(samples[0].messages[1].content) : '""'));
