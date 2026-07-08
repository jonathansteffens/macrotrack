// Generates synthetic text-entry SFT data for the local estimator model.
//
// The trick that makes labels free: meals are COMPOSED from foods.db, so the
// gold FoodClaim (foods, exact grams, per-100g macros, USDA search terms) is
// known by construction — no teacher model needed for ground truth. A share
// of samples renders quantities vaguely and carries a gold clarifying
// question, teaching the ask-vs-don't-ask policy. Mixed dishes (burritos,
// sandwiches, stir-fries) teach decomposition with typical portions.
//
// Eval hold-out: any composed meal whose resolved DB food set matches an
// eval case in tools/eval/cases.jsonl is skipped and regenerated, so the
// eval set can never leak into training data (verify with
// tools/eval/check-overlap.mjs).
//
//   node tools/finetune/generate-synthetic.mjs --n 2000 --seed 7 --out tools/finetune/sft-text.jsonl
//
// Paraphrase passes (phrasing diversity on the user turn):
//   --paraphrase-url http://host:port/v1 --paraphrase-model <name>
//       rewrites via any OpenAI-compatible endpoint. Use an OPEN-WEIGHTS
//       teacher (e.g. Qwen2.5-VL-72B on llama-server/vllm/sglang) for
//       TRAINING data.
//   --paraphrase
//       rewrites with claude-haiku-4-5 (needs ANTHROPIC_API_KEY). NOT for
//       training data — Anthropic ToS forbids training on model outputs.
//       Kept for generating eval/demo variants only.
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
const PARAPHRASE_URL = arg('paraphrase-url', null);
const PARAPHRASE_MODEL = arg('paraphrase-model', 'teacher');
const PARAPHRASE_CONCURRENCY = parseInt(arg('paraphrase-concurrency', '8'), 10);
// Fraction of samples to paraphrase (0..1). A 50/50 mix of teacher and
// template phrasing gives broader style coverage than 100% of either.
const PARAPHRASE_FRAC = parseFloat(arg('paraphrase-frac', '1'));
// Fraction of samples that are a "base + add-on" pair ("toast with butter"),
// teaching the model to emit the add-on as its own item (it was dropping them).
const ADDON_FRAC = parseFloat(arg('addon-frac', '0.18'));

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
    { q: 'chicken breast meat only roasted', name: 'roasted chicken breast', units: [{ kind: 'g', min: 100, max: 250 }, { kind: 'count', unit: 'small roasted chicken breast', g: 140, min: 1, max: 2 }] },
    { q: 'chicken thigh meat only roasted', name: 'roasted chicken thighs', units: [{ kind: 'count', unit: 'roasted chicken thigh', g: 75, min: 1, max: 3 }] },
    { q: 'beef ground 85 lean meat 15 fat patty cooked broiled', name: 'grilled beef patty', units: [{ kind: 'count', unit: 'patty', g: 90, min: 1, max: 2 }] },
    { q: 'beef top sirloin steak cooked broiled', name: 'grilled sirloin steak', units: [{ kind: 'g', min: 120, max: 250 }, { kind: 'count', unit: 'small sirloin steak', g: 170, min: 1, max: 1 }] },
    { q: 'salmon atlantic farmed cooked dry heat', name: 'cooked salmon', units: [{ kind: 'g', min: 100, max: 200 }, { kind: 'count', unit: 'fillet', g: 150, min: 1, max: 1 }] },
    { q: 'fish tilapia cooked dry heat', name: 'baked tilapia', units: [{ kind: 'count', unit: 'fillet', g: 115, min: 1, max: 2 }, { kind: 'g', min: 100, max: 200 }] },
    { q: 'crustaceans shrimp cooked moist heat', name: 'cooked shrimp', units: [{ kind: 'g', min: 80, max: 180 }] },
    { q: 'egg whole cooked scrambled', name: 'scrambled eggs', units: [{ kind: 'count', unit: 'scrambled egg', g: 61, min: 1, max: 4 }] },
    { q: 'egg whole cooked hard boiled', name: 'hard-boiled eggs', units: [{ kind: 'count', unit: 'hard-boiled egg', g: 50, min: 1, max: 3 }] },
    { q: 'egg whole cooked fried', name: 'fried eggs', units: [{ kind: 'count', unit: 'fried egg', g: 46, min: 1, max: 3 }] },
    { q: 'tuna light canned water drained', name: 'canned tuna', units: [{ kind: 'count', unit: 'can', g: 140, min: 1, max: 1 }, { kind: 'g', min: 80, max: 160 }] },
    { q: 'pork chop loin boneless cooked broiled', name: 'grilled pork chop', units: [{ kind: 'count', unit: 'grilled pork chop', g: 150, min: 1, max: 1 }] },
    { q: 'pork cured bacon cooked', name: 'bacon', units: [{ kind: 'count', unit: 'slice', g: 9, min: 2, max: 4 }] },
    { q: 'pork sausage link patty cooked', name: 'breakfast sausage', units: [{ kind: 'count', unit: 'link', g: 27, min: 2, max: 4 }] },
    { q: 'turkey ground cooked', name: 'cooked ground turkey', units: [{ kind: 'g', min: 80, max: 180 }] },
    { q: 'ham sliced regular', name: 'sliced deli ham', units: [{ kind: 'count', unit: 'slice', g: 28, min: 2, max: 4 }, { kind: 'g', min: 40, max: 100 }] },
    { q: 'tofu firm', name: 'firm tofu', units: [{ kind: 'g', min: 80, max: 200 }] },
    { q: 'lentils cooked boiled', name: 'cooked lentils', units: [{ kind: 'measure', unit: 'cup', g: 198, fractions: true }] },
    { q: 'chickpeas garbanzo cooked boiled', name: 'chickpeas', units: [{ kind: 'measure', unit: 'cup', g: 164, fractions: true }] },
  ],
  starch: [
    { q: 'rice white long grain regular enriched cooked', name: 'white rice', units: [{ kind: 'measure', unit: 'cup', g: 160, fractions: true }] },
    { q: 'rice brown long grain cooked', name: 'brown rice', units: [{ kind: 'measure', unit: 'cup', g: 195, fractions: true }] },
    { q: 'pasta cooked enriched without added salt', name: 'cooked pasta', units: [{ kind: 'measure', unit: 'cup', g: 140, fractions: true }] },
    { q: 'rice noodles cooked', name: 'rice noodles', units: [{ kind: 'measure', unit: 'cup', g: 176, fractions: true }] },
    { q: 'couscous cooked', name: 'cooked couscous', units: [{ kind: 'measure', unit: 'cup', g: 157, fractions: true }] },
    { q: 'bread whole wheat commercially prepared toasted', name: 'whole wheat toast', units: [{ kind: 'count', unit: 'slice', g: 26, min: 1, max: 3 }] },
    { q: 'bread white commercially prepared', name: 'white bread', units: [{ kind: 'count', unit: 'slice', g: 27, min: 1, max: 3 }] },
    { q: 'bagels plain enriched', name: 'plain bagel', units: [{ kind: 'count', unit: 'plain bagel', g: 99, min: 1, max: 1 }] },
    { q: 'croissants butter', name: 'butter croissant', units: [{ kind: 'count', unit: 'butter croissant', g: 57, min: 1, max: 2 }] },
    { q: 'muffins blueberry commercially prepared', name: 'blueberry muffin', units: [{ kind: 'count', unit: 'blueberry muffin', g: 113, min: 1, max: 1 }] },
    { q: 'pancakes plain frozen ready to heat', name: 'pancakes', units: [{ kind: 'count', unit: 'pancake', g: 41, min: 2, max: 4 }] },
    { q: 'french toast prepared recipe', name: 'french toast', units: [{ kind: 'count', unit: 'slice', g: 65, min: 1, max: 3 }] },
    { q: 'potatoes baked flesh and skin', name: 'baked potato', units: [{ kind: 'count', unit: 'medium baked potato', g: 173, min: 1, max: 1 }] },
    { q: 'sweet potato cooked baked skin', name: 'baked sweet potato', units: [{ kind: 'count', unit: 'medium sweet potato', g: 114, min: 1, max: 1 }] },
    { q: 'oats regular and quick cooked with water', name: 'cooked oatmeal', units: [{ kind: 'measure', unit: 'cup', g: 234, fractions: true }] },
    { q: 'cereals corn flakes', name: 'corn flakes', units: [{ kind: 'measure', unit: 'cup', g: 28, fractions: false }] },
    { q: 'granola homemade', name: 'granola', units: [{ kind: 'measure', unit: 'cup', g: 122, fractions: true }] },
    { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', units: [{ kind: 'count', unit: 'large tortilla', g: 70, min: 1, max: 2 }] },
    { q: 'quinoa cooked', name: 'cooked quinoa', units: [{ kind: 'measure', unit: 'cup', g: 185, fractions: true }] },
  ],
  vegetable: [
    { q: 'broccoli cooked boiled drained without salt', name: 'steamed broccoli', units: [{ kind: 'measure', unit: 'cup', g: 156, fractions: true }] },
    { q: 'carrots raw', name: 'baby carrots', units: [{ kind: 'g', min: 50, max: 120 }] },
    { q: 'spinach raw', name: 'raw spinach', units: [{ kind: 'measure', unit: 'cup', g: 30, fractions: false }] },
    { q: 'beans black mature seeds cooked boiled', name: 'black beans', units: [{ kind: 'measure', unit: 'cup', g: 172, fractions: true }] },
    { q: 'lettuce cos or romaine raw', name: 'romaine lettuce', units: [{ kind: 'measure', unit: 'cup', g: 47, fractions: false }] },
    { q: 'beans snap green cooked boiled', name: 'green beans', units: [{ kind: 'measure', unit: 'cup', g: 125, fractions: true }] },
    { q: 'tomatoes red ripe raw', name: 'tomato', units: [{ kind: 'count', unit: 'medium tomato', g: 123, min: 1, max: 2 }] },
    { q: 'cucumber raw', name: 'sliced cucumber', units: [{ kind: 'measure', unit: 'cup', g: 119, fractions: false }] },
    { q: 'peppers sweet red raw', name: 'red bell pepper', units: [{ kind: 'count', unit: 'medium red bell pepper', g: 119, min: 1, max: 1 }] },
    { q: 'vegetables mixed frozen cooked boiled', name: 'mixed vegetables', units: [{ kind: 'measure', unit: 'cup', g: 182, fractions: true }] },
    { q: 'edamame frozen prepared', name: 'shelled edamame', units: [{ kind: 'measure', unit: 'cup', g: 155, fractions: true }] },
  ],
  fat: [
    { q: 'oil olive salad or cooking', name: 'olive oil', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }] },
    { q: 'oil canola', name: 'canola oil', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }] },
    { q: 'butter salted', name: 'butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }] },
    { q: 'peanut butter smooth style with salt', name: 'peanut butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 16, fractions: false }] },
    { q: 'nuts almond butter plain', name: 'almond butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 16, fractions: false }] },
    { q: 'avocados raw all commercial varieties', name: 'avocado', units: [{ kind: 'count', unit: 'half avocado', g: 100, min: 1, max: 2 }] },
    { q: 'nuts almonds', name: 'almonds', units: [{ kind: 'g', min: 15, max: 45 }, { kind: 'count', unit: 'handful', g: 28, min: 1, max: 2 }] },
    { q: 'walnuts english', name: 'walnuts', units: [{ kind: 'g', min: 15, max: 40 }, { kind: 'count', unit: 'handful', g: 28, min: 1, max: 1 }] },
    { q: 'salad dressing ranch regular', name: 'ranch dressing', units: [{ kind: 'measure', unit: 'tablespoon', g: 15, fractions: false }] },
    { q: 'salad dressing mayonnaise regular', name: 'mayonnaise', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }] },
    { q: 'cream sour cultured', name: 'sour cream', units: [{ kind: 'measure', unit: 'tablespoon', g: 12, fractions: false }] },
    { q: 'cheese cream', name: 'cream cheese', units: [{ kind: 'measure', unit: 'tablespoon', g: 15, fractions: false }] },
  ],
  fruit: [
    { q: 'bananas raw', name: 'banana', units: [{ kind: 'count', unit: 'medium banana', g: 118, min: 1, max: 2 }] },
    { q: 'apples raw skin', name: 'apple', units: [{ kind: 'count', unit: 'medium apple', g: 182, min: 1, max: 1 }] },
    { q: 'strawberries raw', name: 'strawberries', units: [{ kind: 'measure', unit: 'cup', g: 152, fractions: true }] },
    { q: 'blueberries raw', name: 'blueberries', units: [{ kind: 'measure', unit: 'cup', g: 148, fractions: true }] },
    { q: 'oranges raw all commercial varieties', name: 'orange', units: [{ kind: 'count', unit: 'medium orange', g: 131, min: 1, max: 1 }] },
    { q: 'grapes european type raw', name: 'red grapes', units: [{ kind: 'measure', unit: 'cup', g: 151, fractions: true }] },
    { q: 'watermelon raw', name: 'diced watermelon', units: [{ kind: 'measure', unit: 'cup', g: 152, fractions: true }] },
    { q: 'pineapple raw all varieties', name: 'pineapple chunks', units: [{ kind: 'measure', unit: 'cup', g: 165, fractions: true }] },
    { q: 'mangos raw', name: 'diced mango', units: [{ kind: 'measure', unit: 'cup', g: 165, fractions: true }] },
    { q: 'peaches raw', name: 'peach', units: [{ kind: 'count', unit: 'medium peach', g: 150, min: 1, max: 1 }] },
  ],
  dairy: [
    { q: 'yogurt greek plain nonfat', name: 'plain nonfat greek yogurt', units: [{ kind: 'measure', unit: 'cup', g: 245, fractions: true }] },
    { q: 'yogurt plain whole milk', name: 'plain whole-milk yogurt', units: [{ kind: 'measure', unit: 'cup', g: 245, fractions: true }] },
    { q: 'milk reduced fat fluid 2', name: '2% milk', units: [{ kind: 'measure', unit: 'cup', g: 244, fractions: false }] },
    { q: 'cheese cheddar', name: 'cheddar cheese', units: [{ kind: 'g', min: 20, max: 60 }, { kind: 'count', unit: 'slice', g: 21, min: 1, max: 2 }] },
    { q: 'cheese mozzarella part skim', name: 'mozzarella', units: [{ kind: 'g', min: 20, max: 60 }] },
    { q: 'cheese swiss', name: 'swiss cheese', units: [{ kind: 'count', unit: 'slice', g: 28, min: 1, max: 2 }] },
    { q: 'cheese cottage lowfat 2 milkfat', name: 'cottage cheese', units: [{ kind: 'measure', unit: 'cup', g: 226, fractions: true }] },
    { q: 'ice creams vanilla', name: 'vanilla ice cream', units: [{ kind: 'measure', unit: 'cup', g: 132, fractions: true }] },
  ],
  snack: [
    { q: 'snacks potato chips plain salted', name: 'potato chips', units: [{ kind: 'g', min: 20, max: 50 }, { kind: 'count', unit: 'small bag', g: 28, min: 1, max: 1 }] },
    { q: 'popcorn air popped', name: 'air-popped popcorn', units: [{ kind: 'measure', unit: 'cup', g: 8, fractions: false }] },
    { q: 'chocolate dark 70 85', name: 'dark chocolate', units: [{ kind: 'g', min: 15, max: 40 }] },
    { q: 'cookies chocolate chip commercially prepared', name: 'chocolate chip cookies', units: [{ kind: 'count', unit: 'chocolate chip cookie', g: 15, min: 1, max: 3 }] },
    { q: 'snacks pretzels hard plain salted', name: 'pretzels', units: [{ kind: 'g', min: 20, max: 50 }] },
    { q: 'snacks granola bars hard plain', name: 'granola bar', units: [{ kind: 'count', unit: 'granola bar', g: 25, min: 1, max: 2 }] },
    { q: 'snacks trail mix regular', name: 'trail mix', units: [{ kind: 'g', min: 30, max: 60 }] },
    { q: 'hummus commercial', name: 'hummus', units: [{ kind: 'measure', unit: 'tablespoon', g: 15, fractions: false }] },
  ],
  drink: [
    { q: 'orange juice raw', name: 'orange juice', units: [{ kind: 'measure', unit: 'cup', g: 248, fractions: false }] },
    { q: 'beverages carbonated cola regular', name: 'regular cola', units: [{ kind: 'count', unit: 'can', g: 368, min: 1, max: 1 }] },
    { q: 'beer regular all', name: 'regular beer', units: [{ kind: 'count', unit: 'can', g: 356, min: 1, max: 2 }] },
    { q: 'milk whole 3.25', name: 'whole milk', units: [{ kind: 'measure', unit: 'cup', g: 244, fractions: false }] },
  ],
  fastfood: [
    { q: 'fast foods potato french fried', name: 'french fries', units: [{ kind: 'count', unit: 'medium serving', g: 115, min: 1, max: 1 }, { kind: 'g', min: 70, max: 170 }] },
    { q: 'taco beef hard shell', name: 'beef tacos', units: [{ kind: 'count', unit: 'beef taco', g: 100, min: 1, max: 3 }] },
    { q: 'pizza cheese regular crust frozen cooked', name: 'cheese pizza', units: [{ kind: 'count', unit: 'slice', g: 107, min: 1, max: 3 }] },
  ],
};

// Snackable fats only (peanut butter, avocado, almonds) — nobody snacks on
// a spoonful of olive oil
POOLS.snackfat = POOLS.fat.filter((f) =>
  ['peanut butter', 'avocado', 'almonds', 'walnuts'].includes(f.name)
);

// ---- Mixed dishes: one phrase in the text, decomposed items in the claim ----
// Teaches decomposition with typical portions (confidence 0.7 — estimated,
// not stated). Component grams get ±15% jitter per sample.
const DISHES = {
  breakfast: [
    { text: 'a big breakfast plate', components: [
      { q: 'egg whole cooked fried', name: 'fried eggs', g: 92, prep: 'fried' },
      { q: 'pork cured bacon cooked', name: 'bacon', g: 27, prep: null },
      { q: 'bread whole wheat commercially prepared toasted', name: 'whole wheat toast', g: 26, prep: null },
      { q: 'butter salted', name: 'butter', g: 7, prep: 'on the toast' },
    ] },
    { text: 'a greek yogurt parfait', components: [
      { q: 'yogurt greek plain nonfat', name: 'greek yogurt', g: 245, prep: null },
      { q: 'granola homemade', name: 'granola', g: 30, prep: null },
      { q: 'blueberries raw', name: 'blueberries', g: 74, prep: null },
    ] },
    { text: 'a protein shake with a banana', components: [
      { q: 'beverages protein powder whey', name: 'whey protein powder', g: 30, prep: null },
      { q: 'milk whole 3.25', name: 'whole milk', g: 244, prep: null },
      { q: 'bananas raw', name: 'banana', g: 118, prep: null },
    ] },
  ],
  main: [
    { text: 'a chicken burrito', components: [
      { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70, prep: null },
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 80, prep: null },
      { q: 'beans black mature seeds cooked boiled', name: 'black beans', g: 60, prep: null },
      { q: 'chicken breast meat only roasted', name: 'grilled chicken', g: 85, prep: 'grilled' },
      { q: 'cheese cheddar', name: 'shredded cheese', g: 28, prep: null },
    ] },
    { text: 'a beef burrito', components: [
      { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70, prep: null },
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 80, prep: null },
      { q: 'beans black mature seeds cooked boiled', name: 'black beans', g: 60, prep: null },
      { q: 'beef ground 85 lean meat 15 fat patty cooked broiled', name: 'ground beef', g: 85, prep: null },
      { q: 'cheese cheddar', name: 'shredded cheese', g: 28, prep: null },
    ] },
    { text: 'a turkey and swiss sandwich', components: [
      { q: 'bread whole wheat commercially prepared', name: 'whole wheat bread', g: 64, prep: null },
      { q: 'turkey breast deli', name: 'deli turkey breast', g: 71, prep: null },
      { q: 'cheese swiss', name: 'swiss cheese', g: 28, prep: null },
      { q: 'salad dressing mayonnaise regular', name: 'mayonnaise', g: 14, prep: null },
    ] },
    { text: 'a ham and cheese sandwich', components: [
      { q: 'bread white commercially prepared', name: 'white bread', g: 54, prep: null },
      { q: 'ham sliced regular', name: 'sliced ham', g: 57, prep: null },
      { q: 'cheese cheddar', name: 'cheddar cheese', g: 21, prep: null },
      { q: 'salad dressing mayonnaise regular', name: 'mayonnaise', g: 14, prep: null },
    ] },
    { text: 'a peanut butter and jelly sandwich', components: [
      { q: 'bread white commercially prepared', name: 'white bread', g: 54, prep: null },
      { q: 'peanut butter smooth style with salt', name: 'peanut butter', g: 32, prep: null },
      { q: 'jams preserves', name: 'jam', g: 20, prep: null },
    ] },
    { text: 'a cheeseburger with ketchup', components: [
      { q: 'rolls hamburger plain', name: 'hamburger bun', g: 44, prep: null },
      { q: 'beef ground 80 patty cooked broiled', name: 'beef patty', g: 85, prep: 'grilled' },
      { q: 'cheese american', name: 'american cheese', g: 21, prep: null },
      { q: 'catsup', name: 'ketchup', g: 15, prep: null },
    ] },
    { text: 'a hot dog with ketchup', components: [
      { q: 'frankfurter beef', name: 'beef hot dog', g: 48, prep: null },
      { q: 'rolls hamburger plain', name: 'hot dog bun', g: 44, prep: null },
      { q: 'catsup', name: 'ketchup', g: 15, prep: null },
    ] },
    { text: 'a cheese quesadilla with sour cream', components: [
      { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70, prep: null },
      { q: 'cheese cheddar', name: 'shredded cheddar', g: 55, prep: 'melted' },
      { q: 'cream sour cultured', name: 'sour cream', g: 24, prep: null },
    ] },
    { text: 'a chicken stir fry over brown rice', components: [
      { q: 'chicken breast meat only roasted', name: 'chicken breast', g: 120, prep: 'stir-fried' },
      { q: 'vegetables mixed frozen cooked boiled', name: 'mixed vegetables', g: 120, prep: 'stir-fried' },
      { q: 'oil canola', name: 'cooking oil', g: 14, prep: 'used for stir-frying' },
      { q: 'rice brown long grain cooked', name: 'brown rice', g: 160, prep: null },
    ] },
    { text: 'spaghetti with meat sauce and parmesan', components: [
      { q: 'pasta cooked enriched without added salt', name: 'spaghetti', g: 200, prep: null },
      { q: 'sauce marinara ready serve', name: 'marinara sauce', g: 125, prep: null },
      { q: 'beef ground 80 patty cooked broiled', name: 'ground beef', g: 75, prep: null },
      { q: 'cheese parmesan grated', name: 'grated parmesan', g: 5, prep: null },
    ] },
    { text: 'a grilled chicken salad with ranch', components: [
      { q: 'lettuce cos or romaine raw', name: 'romaine lettuce', g: 94, prep: null },
      { q: 'chicken breast meat only roasted', name: 'grilled chicken breast', g: 100, prep: 'grilled' },
      { q: 'salad dressing ranch regular', name: 'ranch dressing', g: 30, prep: null },
      { q: 'tomatoes red ripe raw', name: 'cherry tomatoes', g: 62, prep: null },
    ] },
  ],
};

// ---- Base + add-on: a plain food with an explicit topping, phrased "X with Y".
// The model was dropping trailing add-ons ("toast with butter" → just toast),
// because add-ons only appeared inside fixed dish templates or as coordinate
// "and" items. Here BOTH the base and the add-on are in the gold claim, so the
// model learns that "with <add-on>" is its own item. `phrase` is how the base
// is typed (with article); `name` is the clean claim name. Confidence 0.7 —
// the foods are named but portions are estimated.
const ADDON_PAIRS = [
  { meal: 'breakfast', base: { q: 'bread whole wheat commercially prepared toasted', name: 'toast', g: 26 }, addon: { q: 'butter salted', name: 'butter', g: 9 } },
  { meal: 'breakfast', base: { q: 'bread whole wheat commercially prepared toasted', name: 'toast', g: 26 }, addon: { q: 'jams preserves', name: 'jam', g: 20 } },
  { meal: 'breakfast', base: { q: 'bread whole wheat commercially prepared toasted', name: 'toast', g: 26 }, addon: { q: 'peanut butter smooth style with salt', name: 'peanut butter', g: 16 } },
  { meal: 'breakfast', base: { q: 'bagels plain enriched', name: 'bagel', g: 99, phrase: 'a bagel' }, addon: { q: 'cheese cream', name: 'cream cheese', g: 30 } },
  { meal: 'breakfast', base: { q: 'oats regular and quick cooked with water', name: 'oatmeal', g: 234 }, addon: { q: 'peanut butter smooth style with salt', name: 'peanut butter', g: 16 } },
  { meal: 'breakfast', base: { q: 'pancakes plain frozen ready to heat', name: 'pancakes', g: 82 }, addon: { q: 'syrups table blends pancake', name: 'maple syrup', g: 40 } },
  { meal: 'breakfast', base: { q: 'waffles plain frozen ready to heat toasted', name: 'waffles', g: 70 }, addon: { q: 'syrups table blends pancake', name: 'syrup', g: 40 } },
  { meal: 'breakfast', base: { q: 'egg whole cooked scrambled', name: 'scrambled eggs', g: 122 }, addon: { q: 'sauce ready to serve pepper or hot', name: 'hot sauce', g: 8 } },
  { meal: 'breakfast', base: { q: 'coffee brewed prepared with tap water', name: 'coffee', g: 240 }, addon: { q: 'cream half and half', name: 'cream', g: 15 }, extra: { q: 'sugars granulated', name: 'sugar', g: 8 } },
  { meal: 'lunch', base: { q: 'fast foods potato french fried', name: 'french fries', g: 115 }, addon: { q: 'catsup', name: 'ketchup', g: 17 } },
  { meal: 'lunch', base: { q: 'chicken breast meat only roasted', name: 'grilled chicken', g: 120 }, addon: { q: 'salad dressing ranch regular', name: 'ranch dressing', g: 30 } },
  { meal: 'dinner', base: { q: 'potatoes baked flesh and skin', name: 'baked potato', g: 173, phrase: 'a baked potato' }, addon: { q: 'butter salted', name: 'butter', g: 14 }, extra: { q: 'cream sour cultured', name: 'sour cream', g: 24 } },
  { meal: 'dinner', base: { q: 'bratwurst pork cooked', name: 'bratwurst', g: 85, phrase: 'a bratwurst' }, addon: { q: 'mustard prepared yellow', name: 'mustard', g: 6 } },
  { meal: 'dinner', base: { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 158 }, addon: { q: 'soy sauce made from soy and wheat shoyu', name: 'soy sauce', g: 16 } },
  { meal: 'snack', base: { q: 'apples raw skin', name: 'apple', g: 182, phrase: 'an apple' }, addon: { q: 'peanut butter smooth style with salt', name: 'peanut butter', g: 16 } },
  { meal: 'snack', base: { q: 'snacks tortilla chips plain', name: 'tortilla chips', g: 28 }, addon: { q: 'salsa', name: 'salsa', g: 30 } },
];

const ADDON_TEMPLATES = ['{b} with {a}', '{b} with {a}', '{b} topped with {a}', '{b} w/ {a}', '{b} and {a}'];

const MEAL_SHAPES = [
  { meal: 'breakfast', slots: [['protein', 'dairy'], ['starch', 'fruit'], ['drink', null, null]], prefix: ['for breakfast I had', 'breakfast:', 'this morning I ate'] },
  { meal: 'breakfast', slots: [['dish:breakfast'], ['drink', null]], prefix: ['for breakfast I had', 'breakfast was', ''] },
  { meal: 'lunch', slots: [['protein'], ['starch', 'vegetable'], ['vegetable', 'fat', null], ['snack', null, null, null]], prefix: ['for lunch:', 'lunch was', 'I had for lunch'] },
  { meal: 'lunch', slots: [['dish:main'], ['snack', 'vegetable', null], ['drink', null, null]], prefix: ['for lunch:', 'lunch was', 'had'] },
  { meal: 'dinner', slots: [['protein'], ['starch'], ['vegetable', null], ['fat', null], ['drink', null, null, null]], prefix: ['dinner:', 'tonight I had', 'for dinner I ate'] },
  { meal: 'dinner', slots: [['dish:main'], ['vegetable', null, null], ['drink', null, null]], prefix: ['dinner:', 'tonight I had', 'for dinner'] },
  { meal: 'dinner', slots: [['fastfood'], ['fastfood', null, null], ['drink', null]], prefix: ['dinner was', 'grabbed', 'tonight I had'] },
  { meal: 'snack', slots: [['fruit', 'snackfat', 'dairy', 'snack', 'snack']], prefix: ['snack:', 'just ate', ''] },
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
for (const dishes of Object.values(DISHES)) {
  for (const dish of dishes) {
    for (const c of dish.components) {
      c.food = search(c.q);
      if (!c.food) throw new Error(`Dish component not found in DB: "${c.q}"`);
    }
  }
}
for (const pair of ADDON_PAIRS) {
  for (const c of [pair.base, pair.addon, ...(pair.extra ? [pair.extra] : [])]) {
    c.food = search(c.q);
    if (!c.food) throw new Error(`Add-on food not found in DB: "${c.q}"`);
  }
}

// ---- Eval hold-out: never generate a meal whose food set matches an eval case ----
const comboKey = (names) => [...new Set(names)].sort().join(' | ');
const EVAL_COMBOS = (() => {
  try {
    const cases = readFileSync(join(HERE, '..', 'eval', 'cases.jsonl'), 'utf8').trim().split('\n');
    return new Set(cases.map((l) => comboKey(JSON.parse(l).truth.map((t) => t.name))));
  } catch {
    console.warn('WARNING: tools/eval/cases.jsonl not found — eval hold-out disabled.');
    return new Set();
  }
})();

// ---- Rendering ----

const numberWords = ['zero', 'one', 'two', 'three', 'four'];
const FRACTION_PHRASES = [
  { phrase: 'half a', f: 0.5 },
  { phrase: 'a', f: 1 },
  { phrase: 'one and a half', f: 1.5 },
  { phrase: 'two', f: 2 },
];

const singular = (w) =>
  /(?:tomatoes|potatoes|[cs]hes|xes|sses)$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, '');
const plural = (w) => {
  if (/(?:tomato|potato|[cs]h|x|ss)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return w.endsWith('s') ? w : `${w}s`;
};
const inflectLast = (words, n) => {
  const parts = words.split(' ');
  parts[parts.length - 1] = n === 1 ? singular(parts[parts.length - 1]) : plural(parts[parts.length - 1]);
  return parts.join(' ');
};

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
    const unitLast = unit.unit.split(' ').pop();
    const nameLast = item.name.split(' ').pop();
    // Unit already names the food ("fried egg", "medium banana") →
    // "two fried eggs"; otherwise "two slices of bacon"
    const phrase =
      singular(unitLast) === singular(nameLast)
        ? `${numberWords[n]} ${inflectLast(unit.unit, n)}`
        : `${numberWords[n]} ${inflectLast(unit.unit, n)} of ${item.name}`;
    return { phrase, grams: n * unit.g };
  }
  // measure (cup / tablespoon)
  const fr = unit.fractions ? pick(FRACTION_PHRASES) : pick(FRACTION_PHRASES.filter((x) => x.f >= 1 && x.f !== 1.5));
  return { phrase: `${fr.phrase} ${inflectLast(unit.unit, fr.f > 1 ? 2 : 1)} of ${item.name}`, grams: Math.round(fr.f * unit.g) };
}

const jitter = (g) => Math.max(5, Math.round(g * (0.85 + rand() * 0.3)));

function makeAddonSample() {
  const p = pick(ADDON_PAIRS);
  const comps = [p.base, p.addon, ...(p.extra ? [p.extra] : [])];
  const tmpl = p.extra ? '{b} with {a} and {e}' : pick(ADDON_TEMPLATES);
  const text = tmpl
    .replace('{b}', p.base.phrase ?? p.base.name)
    .replace('{a}', p.addon.name)
    .replace('{e}', p.extra ? p.extra.name : '');
  const claimItems = comps.map((c) => ({
    name: c.name,
    grams: jitter(c.g),
    prep: null,
    confidence: 0.7,
    db_search_terms: [c.q],
    est_per100: roundedPer100(c.food),
    _dbName: c.food.name,
  }));
  const claim = {
    items: claimItems.map(({ _dbName, ...item }) => item),
    needs_clarification: false,
    questions: [],
    meal_guess: p.meal,
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

function makeSampleOnce() {
  if (rand() < ADDON_FRAC) return makeAddonSample();
  const shape = pick(MEAL_SHAPES);
  const entries = []; // {kind:'item', item, cat} | {kind:'dish', dish}
  for (const slot of shape.slots) {
    const cat = pick(slot);
    if (cat == null) continue;
    if (cat.startsWith('dish:')) {
      entries.push({ kind: 'dish', dish: pick(DISHES[cat.slice(5)]) });
      continue;
    }
    const item = pick(POOLS[cat]);
    if (entries.some((e) => e.kind === 'item' && e.item === item)) continue;
    entries.push({ kind: 'item', item, cat });
  }
  if (entries.length === 0) entries.push({ kind: 'item', item: pick(POOLS.fruit), cat: 'fruit' });

  // ~15% of samples make one high-variance PLAIN component vague → gold
  // question (dishes are excluded: their portions are estimates by nature)
  const plainIdx = entries.map((e, i) => (e.kind === 'item' ? i : -1)).filter((i) => i >= 0);
  const vagueIdx = plainIdx.length && rand() < 0.15 ? pick(plainIdx) : -1;

  const rendered = entries.map((e, i) => {
    if (e.kind === 'dish') {
      return {
        phrase: e.dish.text,
        dish: e.dish,
        claimItems: e.dish.components.map((c) => ({
          name: c.name,
          grams: jitter(c.g),
          prep: c.prep,
          confidence: 0.7,
          db_search_terms: [c.q],
          est_per100: roundedPer100(c.food),
          _dbName: c.food.name,
        })),
      };
    }
    const r = renderComponent(e.item, i === vagueIdx);
    return {
      phrase: r.phrase,
      vagueItem: r.vague ? e.item : undefined,
      claimItems: [{
        name: e.item.name,
        grams: r.grams,
        prep: null,
        confidence: r.vague ? 0.5 : 0.95,
        db_search_terms: [e.item.q],
        est_per100: roundedPer100(e.item.food),
        _dbName: e.item.food.name,
      }],
    };
  });

  const prefix = pick(shape.prefix);
  const list = rendered.map((r) => r.phrase);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  const text = prefix ? `${prefix} ${joined}` : joined;

  const items = rendered.flatMap((r) => r.claimItems);
  const vague = rendered.find((r) => r.vagueItem);
  const claim = {
    items: items.map(({ _dbName, ...item }) => item),
    needs_clarification: !!vague,
    questions: vague
      ? [`Roughly how much ${vague.vagueItem.name} was it — in grams or typical servings?`]
      : [],
    meal_guess: shape.meal,
  };

  return { text, claim, combo: comboKey(items.map((i) => i._dbName)) };
}

function roundedPer100(food) {
  return {
    kcal: Math.round(food.kcal * 10) / 10,
    protein: Math.round((food.protein ?? 0) * 10) / 10,
    carbs: Math.round((food.carbs ?? 0) * 10) / 10,
    fat: Math.round((food.fat ?? 0) * 10) / 10,
  };
}

let heldOut = 0;
function makeSample() {
  for (let tries = 0; tries < 20; tries++) {
    const { text, claim, combo } = makeSampleOnce();
    if (EVAL_COMBOS.has(combo)) {
      heldOut++;
      continue;
    }
    return {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
        { role: 'assistant', content: JSON.stringify(claim) },
      ],
    };
  }
  throw new Error('Could not generate a non-overlapping sample in 20 tries');
}

// ---- Optional paraphrase passes (phrasing diversity on the user turn) ----

const REWRITE_SYSTEM =
  'Rewrite the meal description the way a real person would casually type it into a food tracking app: one short message. Keep every food and every quantity exactly the same (same numbers, same units). Vary phrasing, order, and style. Reply with ONLY the rewritten description — do not add foods, seasonings, comments, questions, or emoji, do not repeat the list, and never mention anything that is not in the original.';

async function paraphraseOpenAI(samples) {
  // Samples are in RNG order (i.e. already shuffled), so "the first frac"
  // is an unbiased subset — and deterministic for a given seed.
  const nTarget = Math.round(samples.length * Math.min(1, Math.max(0, PARAPHRASE_FRAC)));
  console.log(`Paraphrasing ${nTarget}/${samples.length} user texts via ${PARAPHRASE_URL} (${PARAPHRASE_MODEL})…`);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < nTarget) {
      const i = next++;
      const userMsg = samples[i].messages[1];
      try {
        const res = await fetch(`${PARAPHRASE_URL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer none' },
          body: JSON.stringify({
            model: PARAPHRASE_MODEL,
            max_tokens: 200,
            temperature: 0.9,
            messages: [
              { role: 'system', content: REWRITE_SYSTEM },
              { role: 'user', content: userMsg.content },
            ],
          }),
        });
        if (res.ok) {
          const text = (await res.json()).choices?.[0]?.message?.content?.trim();
          // guard against ramblers: a faithful rewrite is about as long as
          // the original — much longer means commentary/repetition crept in
          const clean = text?.replace(/^["']+|["']+$/g, '').trim();
          if (clean && clean.length <= Math.max(80, userMsg.content.length * 2.5)) {
            userMsg.content = clean;
          }
        }
      } catch {
        // keep the original text on failure — template text is still valid SFT
      }
      if (++done % 500 === 0) console.log(`  ${done}/${nTarget}`);
    }
  }
  await Promise.all(Array.from({ length: PARAPHRASE_CONCURRENCY }, worker));
}

async function paraphraseAnthropic(samples) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  console.log('Paraphrasing user texts with claude-haiku-4-5…');
  console.warn('WARNING: Anthropic outputs must NOT be used as training data (ToS). Use --paraphrase-url with an open-weights teacher for SFT sets.');
  for (let i = 0; i < samples.length; i++) {
    const userMsg = samples[i].messages[1];
    const res = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: REWRITE_SYSTEM,
      messages: [{ role: 'user', content: userMsg.content }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text?.trim();
    if (text) userMsg.content = text;
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${samples.length}`);
  }
}

// ---- Main ----

const samples = Array.from({ length: N }, makeSample);
if (PARAPHRASE_URL) await paraphraseOpenAI(samples);
else if (PARAPHRASE) await paraphraseAnthropic(samples);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, samples.map((x) => JSON.stringify(x)).join('\n') + '\n');

const withQ = samples.filter((x) => JSON.parse(x.messages[2].content).needs_clarification).length;
const withDish = samples.filter((x) => JSON.parse(x.messages[2].content).items.some((i) => i.confidence === 0.7)).length;
console.log(`Wrote ${samples.length} samples to ${OUT} (seed ${SEED})`);
console.log(`  with clarifying question: ${withQ} (${Math.round((withQ / samples.length) * 100)}%)`);
console.log(`  with a composed dish:     ${withDish} (${Math.round((withDish / samples.length) * 100)}%)`);
console.log(`  eval-combo collisions skipped: ${heldOut}`);
console.log('Example:', JSON.parse(JSON.stringify(samples[0].messages[1].content)));
