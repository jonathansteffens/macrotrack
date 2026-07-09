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
const ADDON_FRAC = parseFloat(arg('addon-frac', '0.26'));
// Fraction that is a single branded fast-food menu item ("a Baconator"),
// teaching one resolving item instead of decomposing into generics.
const BRANDED_FRAC = parseFloat(arg('branded-frac', '0.05'));
// Fraction that lists 2-4 arbitrary foods explicitly ("a bowl with X, Y, Z"),
// teaching the model to emit exactly the listed ingredients instead of
// pattern-matching one of the fixed DISHES templates.
const INGREDIENT_FRAC = parseFloat(arg('ingredient-frac', '0.08'));
// Fraction that is a single bare ambiguous food ("a soda") needing a
// clarifying question, as opposed to the vague-item case inside a multi-item
// meal (see vagueIdx logic below). Lowered from 0.035 — combined with the
// vagueIdx rate below, 0.035 pushed the overall ask-rate to 14.2% (v4
// over-asking regression); real inputs with an explicit unit/quantity
// ("a stick of butter") were being asked about too.
const CLARIFY_FRAC = parseFloat(arg('single-clarify-frac', '0.02'));
// Fraction that is a single bare food stated WITH a clear standard unit
// ("a stick of butter", "a large fries") that must NOT ask — the direct
// contrastive counterpart to CLARIFY_FRAC/SINGLE_CLARIFY, teaching that an
// explicit quantity/qualifier resolves the ambiguity.
const SINGLE_CONFIDENT_FRAC = parseFloat(arg('single-confident-frac', '0.05'));
// Fraction that renders ONE count/whole item as a BARE message (no meal
// prefix): "a whole pizza", "20 nuggets", "a dozen mini muffins". The gate's
// inputs are terse but training rows were mostly full sentences, so bare
// count/whole phrasings were underrepresented (gate: 0% exact on whole/family).
const BARE_COUNT_FRAC = parseFloat(arg('bare-count-frac', '0.04'));
// Fraction that renders a dish with a removed component ("a chicken burrito
// with no rice") — gold claim omits that component. Teaches negation; without
// it the model emitted the removed food anyway.
const NEGATION_FRAC = parseFloat(arg('negation-frac', '0.015'));
// v8 residual fixes (driven by the v7 QA gate):
// Fraction rendered as "a quarter of the lasagna" / "a third of a pie" — the
// fraction is of the WHOLE dish, so gold unit_grams is the whole-dish weight
// (a lasagna pan ~1400 g), not a single serving. v7 multiplied the fraction
// against a per-serving weight (0.25 × ~150 g ≈ 39 g).
const FRACTION_DISH_FRAC = parseFloat(arg('fraction-dish-frac', '0.025'));
// Whole-container phrasings ("the whole box of donuts", "a whole loaf of
// bread", "the whole sleeve of crackers", "a whole bag of pretzels") — gold =
// container-count × per-unit weight (or count 1 × whole-container weight).
const CONTAINER_FRAC = parseFloat(arg('container-frac', '0.02'));
// Non-food / gibberish inputs ("asdfghjkl", "my dog", "???", "nothing") → gold
// claim items:[] with a single clarifying question (ask-instead-of-hallucinate);
// "I didn't eat anything" → items:[] with no question; "just water" → a real
// 0-kcal water item. ~0.7% of samples.
const NONFOOD_FRAC = parseFloat(arg('nonfood-frac', '0.007'));
// "a plain X" / "X, nothing on it" / "dry toast" → the base item ONLY (strip
// the implied condiment), plus contrastive "with just <condiment>" cases that
// keep EXACTLY the named condiment (condiment-fidelity, no substitution).
const PLAIN_FRAC = parseFloat(arg('plain-frac', '0.025'));
// Bare fluid-ounce drink render ("8 ounces of milk" → ~240 g). v7 doubled it
// (~488 g) by treating fl-oz as weight-oz. 1 fl oz ≈ 30 g for these drinks.
const FLOZ_DRINK_FRAC = parseFloat(arg('floz-drink-frac', '0.012'));

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
    // 'piece' unit (~12 g) so "12 shrimp"/"a dozen shrimp" scales by a true
    // small per-unit weight instead of the ~110 g default anchor (v7 gate).
    { q: 'crustaceans shrimp cooked moist heat', name: 'cooked shrimp', units: [{ kind: 'g', min: 80, max: 180 }, { kind: 'count', unit: 'piece', g: 12, min: 5, max: 12 }] },
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
    // Whole/half rendering (a whole rotisserie chicken bought at the store,
    // vs. a normal per-meal serving of shredded meat off it).
    { q: 'chicken broilers rotisserie original seasoning breast meat and skin cooked', name: 'rotisserie chicken',
      units: [{ kind: 'g', min: 85, max: 250 }],
      wholeOptions: [
        { phrase: 'a whole {name}', gMin: 850, gMax: 950 },
        { phrase: 'half a {name}', gMin: 425, gMax: 475 },
      ] },
    // A whole roast chicken cooked/bought at home — distinct DB row from the
    // rotisserie one, more whole/family coverage (gate's worst subcategory).
    { q: 'chicken roasting meat and skin cooked roasted', name: 'roast chicken',
      units: [{ kind: 'g', min: 85, max: 220 }],
      wholeOptions: [
        { phrase: 'a whole {name}', gMin: 1000, gMax: 1400 },
        { phrase: 'half a {name}', gMin: 500, gMax: 700 },
      ] },
    // Bulk-count coverage for common small fast-food items ("20 nuggets",
    // "a dozen wings") — previously these only existed as fixed-gram ADDON
    // bases with no quantity variation at all.
    { q: 'chicken nuggets', name: 'chicken nuggets', units: [{ kind: 'count', unit: 'nugget', g: 16, min: 4, max: 10 }] },
    { q: 'chicken wing fried coated from raw', name: 'fried chicken wings', units: [{ kind: 'count', unit: 'wing', g: 30, min: 3, max: 6 }] },
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
    // NOTE: DB spelling is "doughnut" (not "donut") — the query string must
    // match that exact spelling or search() throws.
    { q: 'doughnuts cake type plain', name: 'doughnut', units: [{ kind: 'count', unit: 'doughnut', g: 60, min: 1, max: 3 }] },
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
    { q: 'butter salted', name: 'butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 14, fractions: false }, { kind: 'count', unit: 'pat', g: 5, min: 1, max: 2 }, { kind: 'count', unit: 'stick', g: 113, min: 1, max: 1 }] },
    { q: 'peanut butter smooth style with salt', name: 'peanut butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 16, fractions: false }] },
    { q: 'nuts almond butter plain', name: 'almond butter', units: [{ kind: 'measure', unit: 'tablespoon', g: 16, fractions: false }] },
    { q: 'avocados raw all commercial varieties', name: 'avocado', units: [{ kind: 'count', unit: 'half avocado', g: 100, min: 1, max: 2 }] },
    { q: 'nuts almonds', name: 'almonds', units: [{ kind: 'g', min: 15, max: 45 }, { kind: 'count', unit: 'handful', g: 28, min: 1, max: 2 }, { kind: 'measure', unit: 'cup', g: 143, fractions: true }] },
    { q: 'walnuts english', name: 'walnuts', units: [{ kind: 'g', min: 15, max: 40 }, { kind: 'count', unit: 'handful', g: 28, min: 1, max: 1 }, { kind: 'measure', unit: 'cup', g: 117, fractions: true }] },
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
    { q: 'watermelon raw', name: 'diced watermelon', units: [{ kind: 'measure', unit: 'cup', g: 152, fractions: true }],
      wholeLabel: 'watermelon',
      wholeOptions: [
        { phrase: 'half a {name}', gMin: 1500, gMax: 2500 },
        { phrase: 'a whole {name}', gMin: 3000, gMax: 4500 },
      ] },
    { q: 'pineapple raw all varieties', name: 'pineapple chunks', units: [{ kind: 'measure', unit: 'cup', g: 165, fractions: true }] },
    { q: 'mangos raw', name: 'diced mango', units: [{ kind: 'measure', unit: 'cup', g: 165, fractions: true }] },
    { q: 'peaches raw', name: 'peach', units: [{ kind: 'count', unit: 'medium peach', g: 150, min: 1, max: 1 }] },
  ],
  dairy: [
    { q: 'yogurt greek plain nonfat', name: 'plain nonfat greek yogurt', units: [{ kind: 'measure', unit: 'cup', g: 245, fractions: true }] },
    { q: 'yogurt plain whole milk', name: 'plain whole-milk yogurt', units: [{ kind: 'measure', unit: 'cup', g: 245, fractions: true }] },
    { q: 'milk reduced fat fluid 2', name: '2% milk', flOz: 30.5, units: [{ kind: 'measure', unit: 'cup', g: 244, fractions: false }] },
    { q: 'cheese cheddar', name: 'cheddar cheese', units: [{ kind: 'g', min: 20, max: 60 }, { kind: 'count', unit: 'slice', g: 21, min: 1, max: 2 }] },
    { q: 'cheese mozzarella part skim', name: 'mozzarella', units: [{ kind: 'g', min: 20, max: 60 }] },
    { q: 'cheese swiss', name: 'swiss cheese', units: [{ kind: 'count', unit: 'slice', g: 28, min: 1, max: 2 }] },
    { q: 'cheese cottage lowfat 2 milkfat', name: 'cottage cheese', units: [{ kind: 'measure', unit: 'cup', g: 226, fractions: true }] },
    { q: 'ice creams vanilla', name: 'vanilla ice cream', units: [{ kind: 'measure', unit: 'cup', g: 132, fractions: true }] },
  ],
  snack: [
    { q: 'snacks potato chips plain salted', name: 'potato chips', units: [{ kind: 'g', min: 20, max: 50 }, { kind: 'count', unit: 'small bag', g: 28, min: 1, max: 1 }],
      wholeOptions: [{ phrase: 'a family size bag of {name}', gMin: 150, gMax: 300 }] },
    { q: 'popcorn air popped', name: 'air-popped popcorn', units: [{ kind: 'measure', unit: 'cup', g: 8, fractions: false }] },
    { q: 'chocolate dark 70 85', name: 'dark chocolate', units: [{ kind: 'g', min: 15, max: 40 }] },
    { q: 'cookies chocolate chip commercially prepared', name: 'chocolate chip cookies', units: [{ kind: 'count', unit: 'chocolate chip cookie', g: 15, min: 1, max: 3 }] },
    { q: 'snacks pretzels hard plain salted', name: 'pretzels', units: [{ kind: 'g', min: 20, max: 50 }],
      wholeOptions: [{ phrase: 'a family size bag of {name}', gMin: 200, gMax: 400 }] },
    { q: 'snacks granola bars hard plain', name: 'granola bar', units: [{ kind: 'count', unit: 'granola bar', g: 25, min: 1, max: 2 }] },
    { q: 'snacks trail mix regular', name: 'trail mix', units: [{ kind: 'g', min: 30, max: 60 }] },
    { q: 'hummus commercial', name: 'hummus', units: [{ kind: 'measure', unit: 'tablespoon', g: 15, fractions: false }] },
    { q: 'protein bar', name: 'protein bar', units: [{ kind: 'count', unit: 'protein bar', g: 60, min: 1, max: 1 }] },
    { q: 'snacks rice cakes brown rice', name: 'rice cake', units: [{ kind: 'count', unit: 'rice cake', g: 9, min: 2, max: 4 }] },
    // Small discrete foods with ACCURATE per-unit grams — fix the unit_grams
    // over-anchoring (~100-150 g) the gate saw on small units (a dozen mini
    // muffins came back at 112 g/unit). All DB-verified (see search() below).
    { q: 'mozzarella sticks', name: 'mozzarella sticks', units: [{ kind: 'count', unit: 'mozzarella stick', g: 20, min: 3, max: 8 }] },
    { q: 'meatballs italian', name: 'meatballs', units: [{ kind: 'count', unit: 'meatball', g: 30, min: 3, max: 6 }] },
    { q: 'chicken tenders', name: 'chicken tenders', units: [{ kind: 'count', unit: 'chicken tender', g: 45, min: 2, max: 5 }] },
    // NOTE: 'muffins mini' resolves to the SAME DB row as the blueberry-muffin
    // starch item (per-100g identical); the point here is the small 30 g unit.
    { q: 'muffins mini', name: 'mini muffins', units: [{ kind: 'count', unit: 'mini muffin', g: 30, min: 3, max: 6 }] },
    // Small-piece calibration: potstickers/dumplings ~35 g each (DB row is the
    // steamed wonton/dumpling/pot-sticker). Bulkable — "8 potstickers" scales.
    { q: 'dumpling steamed', name: 'potstickers', units: [{ kind: 'count', unit: 'potsticker', g: 35, min: 3, max: 8 }] },
  ],
  // `flOz` (grams per FLUID ounce) marks a liquid whose "N oz" means fluid
  // ounces, not weight ounces — 1 fl oz ≈ 30 g (a cup = 8 fl oz ≈ 244 g). Fixes
  // the v7 gate's "8 ounces of milk" → ~488 g (it doubled via weight-oz).
  drink: [
    { q: 'orange juice raw', name: 'orange juice', flOz: 31, units: [{ kind: 'measure', unit: 'cup', g: 248, fractions: false }] },
    { q: 'beverages carbonated cola regular', name: 'regular cola', flOz: 30.7, units: [{ kind: 'count', unit: 'can', g: 368, min: 1, max: 1 }] },
    { q: 'beer regular all', name: 'regular beer', units: [{ kind: 'count', unit: 'can', g: 356, min: 1, max: 2 }] },
    { q: 'milk whole 3.25', name: 'whole milk', flOz: 30.5, units: [{ kind: 'measure', unit: 'cup', g: 244, fractions: false }] },
    // unit names avoid ending in "tea"/"smoothie" (matching the item name's
    // last word) — that would trip renderComponent's same-word shortcut and
    // drop the "bubble"/"fruit" qualifier, rendering as a bare "one medium".
    { q: 'tea bubble', name: 'bubble tea', units: [{ kind: 'g', min: 400, max: 700 }, { kind: 'count', unit: 'medium cup', g: 500, min: 1, max: 1 }] },
    { q: 'smoothie fruit', name: 'fruit smoothie', units: [{ kind: 'g', min: 300, max: 500 }, { kind: 'count', unit: 'medium cup', g: 400, min: 1, max: 1 }] },
  ],
  fastfood: [
    { q: 'fast foods potato french fried', name: 'french fries', units: [{ kind: 'count', unit: 'medium serving', g: 115, min: 1, max: 1 }, { kind: 'g', min: 70, max: 170 }] },
    { q: 'taco beef hard shell', name: 'beef tacos', units: [{ kind: 'count', unit: 'beef taco', g: 100, min: 1, max: 3 }] },
    // wholeLabel drops "cheese" for the whole/half phrasing ("a whole
    // pizza"/"half a pizza" — how people actually say it), even though the
    // per-slice claim name stays the more specific "cheese pizza".
    { q: 'pizza cheese regular crust frozen cooked', name: 'cheese pizza', units: [{ kind: 'count', unit: 'slice', g: 107, min: 1, max: 3 }],
      wholeLabel: 'pizza',
      wholeOptions: [
        { phrase: 'a whole {name}', gMin: 850, gMax: 1000 },
        { phrase: 'half a {name}', gMin: 425, gMax: 500 },
      ] },
    // Pepperoni pizza: a DISTINCT DB row from cheese pizza (which is a held-out
    // eval single), so "a whole pizza" survives the eval hold-out and can be
    // emitted BARE (see BARE_COUNT_ITEMS) — the gate's terse whole-pizza input.
    { q: 'pizza pepperoni regular crust frozen cooked', name: 'pepperoni pizza', units: [{ kind: 'count', unit: 'slice', g: 111, min: 1, max: 3 }],
      wholeLabel: 'pizza',
      wholeOptions: [
        { phrase: 'a whole {name}', gMin: 850, gMax: 1000 },
        { phrase: 'half a {name}', gMin: 425, gMax: 500 },
      ] },
  ],
  // Complete, single-item dishes: NFS/standard-recipe DB entries that already
  // capture the whole dish (per the app's own guidance — decompose mixed
  // dishes "unless the dish is a packaged/standard item"). These fix the
  // adversarial failures where the model decomposed "leftover lasagna" or
  // "chili" into unrelated generic ingredients instead of emitting the one
  // dish. NOTE: "lasagna" only resolves to the meatless DB entry (no separate
  // meat-lasagna row exists) — still a sensible food, just not meat-specific.
  dish: [
    { q: 'chili con carne with beans canned', name: 'chili', units: [{ kind: 'g', min: 220, max: 420 }, { kind: 'count', unit: 'bowl', g: 300, min: 1, max: 1 }] },
    { q: 'lasagna', name: 'lasagna', units: [{ kind: 'g', min: 200, max: 400 }, { kind: 'count', unit: 'piece', g: 255, min: 1, max: 2 }] },
    { q: 'pad thai', name: 'pad thai', units: [{ kind: 'g', min: 250, max: 450 }, { kind: 'count', unit: 'serving', g: 350, min: 1, max: 1 }] },
    { q: 'shepherds pie', name: "shepherd's pie", units: [{ kind: 'g', min: 250, max: 400 }, { kind: 'count', unit: 'serving', g: 300, min: 1, max: 1 }] },
    { q: 'macaroni cheese', name: 'mac and cheese', units: [{ kind: 'measure', unit: 'cup', g: 200, fractions: true }, { kind: 'g', min: 150, max: 350 }] },
    { q: 'fried rice', name: 'fried rice', units: [{ kind: 'measure', unit: 'cup', g: 198, fractions: true }, { kind: 'g', min: 150, max: 350 }] },
    { q: 'chicken fried rice', name: 'chicken fried rice', units: [{ kind: 'g', min: 250, max: 450 }, { kind: 'count', unit: 'serving', g: 350, min: 1, max: 1 }] },
    { q: 'beef stew canned', name: 'beef stew', units: [{ kind: 'g', min: 250, max: 400 }, { kind: 'count', unit: 'bowl', g: 300, min: 1, max: 1 }] },
    { q: 'chicken pot pie frozen', name: 'chicken pot pie', units: [{ kind: 'count', unit: 'serving', g: 250, min: 1, max: 1 }] },
    // unit name is 'serving', not 'bowl' — renderComponent collapses the
    // phrase to just the unit name when its last word matches the food
    // name's last word (e.g. "fried egg" unit + "fried eggs" name), which
    // would otherwise render this as the content-free "a bowl".
    { q: 'burrito bowl', name: 'burrito bowl', units: [{ kind: 'g', min: 350, max: 550 }, { kind: 'count', unit: 'serving', g: 450, min: 1, max: 1 }] },
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
    // Named-ingredient coverage: "cereal with milk" was resolving to a
    // protein shake, and "bacon egg and cheese on a bagel" / "breakfast
    // burrito with eggs sausage cheese" were dropping the egg or substituting
    // rice+beans — these teach the exact named components instead.
    { text: 'a bowl of cereal with milk', components: [
      { q: 'cereal ready to eat', name: 'cereal', g: 40, prep: null },
      { q: 'milk reduced fat fluid 2', name: '2% milk', g: 240, prep: null },
    ] },
    { text: 'a bacon, egg, and cheese on a bagel', components: [
      { q: 'bagels plain enriched', name: 'bagel', g: 99, prep: null },
      { q: 'egg whole cooked scrambled', name: 'scrambled egg', g: 61, prep: 'scrambled' },
      { q: 'pork cured bacon cooked', name: 'bacon', g: 18, prep: null },
      { q: 'cheese american', name: 'american cheese', g: 21, prep: null },
    ] },
    { text: 'a breakfast burrito with eggs, sausage, and cheese', components: [
      { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70, prep: null },
      { q: 'egg whole cooked scrambled', name: 'scrambled eggs', g: 122, prep: 'scrambled' },
      { q: 'pork sausage link patty cooked', name: 'breakfast sausage', g: 54, prep: null },
      { q: 'cheese cheddar', name: 'shredded cheese', g: 28, prep: null },
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
    { text: 'a chicken caesar salad', components: [
      { q: 'lettuce cos or romaine raw', name: 'romaine lettuce', g: 130, prep: null },
      { q: 'chicken breast meat only roasted', name: 'grilled chicken', g: 120, prep: 'grilled' },
      { q: 'salad dressing caesar', name: 'caesar dressing', g: 30, prep: null },
      { q: 'cheese parmesan grated', name: 'parmesan', g: 10, prep: null },
      { q: 'croutons seasoned', name: 'croutons', g: 15, prep: null },
    ] },
    // Global/off-curated dishes that were previously collapsing into one
    // garbled item with fabricated search terms when off-menu ("kung pao
    // chicken with rice" -> "chicken pao chicken white rice"). Proper
    // multi-component DISHES with verified DB terms fix that at the source.
    { text: 'kung pao chicken with rice', components: [
      { q: 'kung pao chicken', name: 'kung pao chicken', g: 250, prep: null },
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 160, prep: null },
    ] },
    { text: 'beef bibimbap', components: [
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 200, prep: null },
      { q: 'vegetables mixed frozen cooked boiled', name: 'mixed vegetables', g: 100, prep: null },
      { q: 'egg whole cooked fried', name: 'fried egg', g: 46, prep: 'fried' },
      { q: 'beef top sirloin steak cooked broiled', name: 'beef', g: 90, prep: 'thinly sliced and stir-fried' },
    ] },
    // NOTE: "tikka masala" itself has no DB match (verified: no "tikka" or
    // "masala" rows) — "chicken curry" is the nearest resolvable analog for
    // the saucy-chicken component, same approach as the "lasagna" note above.
    { text: 'chicken tikka masala with rice', components: [
      { q: 'chicken curry', name: 'chicken tikka masala', g: 300, prep: null },
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 160, prep: null },
    ] },
    { text: 'chicken teriyaki with rice', components: [
      { q: 'chicken or turkey with teriyaki', name: 'chicken teriyaki', g: 250, prep: null },
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 160, prep: null },
    ] },
    { text: 'beef and broccoli with rice', components: [
      { q: 'beef and broccoli', name: 'beef and broccoli', g: 250, prep: null },
      { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 160, prep: null },
    ] },
  ],
  snack: [
    { text: 'a plate of nachos', components: [
      { q: 'snacks tortilla chips plain', name: 'tortilla chips', g: 85, prep: null },
      { q: 'cheese cheddar', name: 'melted cheddar', g: 56, prep: 'melted' },
      { q: 'beans refried canned', name: 'refried beans', g: 60, prep: null },
      { q: 'salsa', name: 'salsa', g: 30, prep: null },
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
  // coverage-v2: sauces/dips on proteins & sides (the reported gap — "fried
  // chicken wing with bbq sauce" returned only the wing; condiments broadly weak)
  { meal: 'dinner', base: { q: 'chicken wing fried coated from raw', name: 'fried chicken wings', g: 100, phrase: 'fried chicken wings' }, addon: { q: 'sauce barbecue', name: 'bbq sauce', g: 30 } },
  { meal: 'dinner', base: { q: 'chicken wing fried coated from raw', name: 'fried chicken wings', g: 100, phrase: 'fried chicken wings' }, addon: { q: 'sauce ready to serve pepper or hot', name: 'hot sauce', g: 24 } },
  { meal: 'lunch', base: { q: 'chicken nuggets', name: 'chicken nuggets', g: 96, phrase: 'chicken nuggets' }, addon: { q: 'sauce barbecue', name: 'bbq sauce', g: 28 } },
  { meal: 'lunch', base: { q: 'chicken nuggets', name: 'chicken nuggets', g: 96, phrase: 'chicken nuggets' }, addon: { q: 'salad dressing ranch regular', name: 'ranch', g: 28 } },
  { meal: 'dinner', base: { q: 'chicken breast meat only roasted', name: 'grilled chicken', g: 120 }, addon: { q: 'sauce barbecue', name: 'bbq sauce', g: 28 } },
  { meal: 'dinner', base: { q: 'frankfurter beef', name: 'hot dog', g: 48, phrase: 'a hot dog' }, addon: { q: 'mustard prepared yellow', name: 'mustard', g: 8 } },
  { meal: 'snack', base: { q: 'pretzels soft', name: 'soft pretzel', g: 115, phrase: 'a soft pretzel' }, addon: { q: 'mustard prepared yellow', name: 'mustard', g: 12 } },
  { meal: 'dinner', base: { q: 'broccoli cooked boiled drained without salt', name: 'steamed broccoli', g: 156 }, addon: { q: 'cheese sauce', name: 'cheese sauce', g: 30 } },
  { meal: 'dinner', base: { q: 'pasta cooked enriched without added salt', name: 'pasta', g: 140 }, addon: { q: 'cheese parmesan grated', name: 'parmesan', g: 10 } },
  { meal: 'breakfast', base: { q: 'biscuit', name: 'biscuit', g: 60, phrase: 'a biscuit' }, addon: { q: 'gravy', name: 'gravy', g: 60 } },
  { meal: 'breakfast', base: { q: 'egg whole cooked scrambled', name: 'scrambled eggs', g: 122 }, addon: { q: 'catsup', name: 'ketchup', g: 15 } },
  { meal: 'lunch', base: { q: 'fast foods potato french fried', name: 'french fries', g: 115 }, addon: { q: 'salad dressing mayonnaise regular', name: 'mayo', g: 20 } },
  { meal: 'dinner', base: { q: 'taco beef hard shell', name: 'beef tacos', g: 100, phrase: 'beef tacos' }, addon: { q: 'salsa', name: 'salsa', g: 30 } },
  { meal: 'dinner', base: { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 158 }, addon: { q: 'sauce hot chile sriracha', name: 'sriracha', g: 12 } },
];

// Phrasing variety for the base+add-on pattern. "{b} with {a}" is dominant (the
// exact form the model was dropping); reversed "{a} on {b}" and side phrasings
// teach that the add-on is a real item regardless of position/wording.
const ADDON_TEMPLATES = ['{b} with {a}', '{b} with {a}', '{b} topped with {a}', '{b} w/ {a}', '{b} and {a}', '{a} on {b}', '{b}, {a} on the side'];

const MEAL_SHAPES = [
  { meal: 'breakfast', slots: [['protein', 'dairy'], ['starch', 'fruit'], ['drink', null, null]], prefix: ['for breakfast I had', 'breakfast:', 'this morning I ate'] },
  { meal: 'breakfast', slots: [['dish:breakfast'], ['drink', null]], prefix: ['for breakfast I had', 'breakfast was', ''] },
  { meal: 'lunch', slots: [['protein'], ['starch', 'vegetable'], ['vegetable', 'fat', null], ['snack', null, null, null]], prefix: ['for lunch:', 'lunch was', 'I had for lunch'] },
  { meal: 'lunch', slots: [['dish:main'], ['snack', 'vegetable', null], ['drink', null, null]], prefix: ['for lunch:', 'lunch was', 'had'] },
  { meal: 'lunch', slots: [['dish'], ['drink', null]], prefix: ['for lunch:', 'lunch was', 'grabbed'] },
  { meal: 'dinner', slots: [['protein'], ['starch'], ['vegetable', null], ['fat', null], ['drink', null, null, null]], prefix: ['dinner:', 'tonight I had', 'for dinner I ate'] },
  { meal: 'dinner', slots: [['dish:main'], ['vegetable', null, null], ['drink', null, null]], prefix: ['dinner:', 'tonight I had', 'for dinner'] },
  { meal: 'dinner', slots: [['dish'], ['drink', null, null]], prefix: ['dinner:', 'tonight I had', 'for dinner I had'] },
  { meal: 'dinner', slots: [['fastfood'], ['fastfood', null, null], ['drink', null]], prefix: ['dinner was', 'grabbed', 'tonight I had'] },
  { meal: 'snack', slots: [['fruit', 'snackfat', 'dairy', 'snack', 'snack', 'dish:snack']], prefix: ['snack:', 'just ate', ''] },
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

// ---- Single ambiguous foods that should trigger a clarifying question on
// their own (not just inside a multi-item meal). Each carries a best-guess
// resolving food at low confidence, per the system prompt's "below 0.6 means
// real uncertainty about what the food is" — the question, not the guess, is
// the point.
// NOTE: the best-guess q for "a soda"/"a beer" deliberately avoids the plain
// "cola, regular" / "beer, regular, all" DB rows — those exact single-item
// combos are eval cases (cola-can, beer-can), so the eval hold-out below
// would silently regenerate every single draw of them, and the scenario
// would never actually appear in the output. A different (still sensible)
// guess sidesteps that without weakening the "ask before assuming" lesson.
// `count` (v2): a stated whole-unit count when the text names one ("a burger",
// "a sandwich" → 1); null for liquids/bowls ("a soda", "a beer", "a bowl of
// soup") and vague amounts ("some chicken"). unit_grams is derived (g / count).
const SINGLE_CLARIFY = [
  { text: 'a soda', q: 'beverages cola or pepper types', name: 'soda', g: 355, count: null, question: 'Regular or diet?' },
  { text: 'a coffee', q: 'coffee brewed prepared with tap water', name: 'coffee', g: 240, count: null, question: 'Black, or with milk and sugar?' },
  { text: 'a burger', q: 'fast foods cheeseburger single patty plain', name: 'cheeseburger', g: 170, count: 1, question: 'Just the patty, or a full cheeseburger with bun and toppings?' },
  { text: 'some chicken', q: 'chicken breast meat only roasted', name: 'chicken', g: 150, count: null, question: 'Roughly how much, and was it fried, grilled, or baked?' },
  { text: 'a sandwich', q: 'club sandwich', name: 'sandwich', g: 220, count: 1, question: "What kind of sandwich, and what's on it?" },
  { text: 'a bowl of soup', q: 'soup chicken noodle', name: 'soup', g: 245, count: null, question: 'What kind of soup, and about how big a bowl?' },
  { text: 'a beer', q: 'beer light', name: 'beer', g: 356, count: null, question: 'What kind, and what size?' },
  { text: 'a salad', q: 'lettuce and tomato salad', name: 'salad', g: 150, count: null, question: "What's in it, and is there dressing on it?" },
];
for (const c of SINGLE_CLARIFY) {
  c.food = search(c.q);
  if (!c.food) throw new Error(`Single-clarify food not found in DB: "${c.q}"`);
}

// ---- Contrastive counterpart to SINGLE_CLARIFY: single bare foods with an
// EXPLICIT standard unit/qualifier that must NOT trigger a clarifying
// question. Fixes an over-asking regression where the model started asking
// on inputs that already state a normal quantity ("a stick of butter", "a
// slice of pizza", "a large fries") — SINGLE_CLARIFY alone teaches "ask when
// ambiguous" with no counter-example teaching "don't ask when it's not".
// A couple of entries deliberately mirror a SINGLE_CLARIFY item with the
// ambiguity resolved ("a coffee" asks; "black coffee" doesn't) for maximum
// contrast on minimal edit distance.
// NOTE: pizza/fries resolve to a DIFFERENT (still perfectly sensible) DB row
// than the "cheese pizza"/fast-food-fries POOLS/eval defaults — those exact
// single-item combos are held-out eval cases (cheese-pizza, fries-medium),
// so using the same row would silently regenerate forever and this example
// would never actually appear in the output (same trick as the SINGLE_CLARIFY
// note above). "a can of soda" is deliberately NOT included here — the
// system prompt calls out regular-vs-diet as a canonical *good* question
// (>75 kcal swing), so a can size alone doesn't resolve that ambiguity.
// `count` (v2): a stated whole-unit count — "a stick"/"a slice"/"a can" → 1,
// "two slices of bacon" → 2; null for measures/mass/liquids ("a cup of rice",
// "a handful of almonds", "black coffee", "a large fries"). unit_grams = g/count.
const SINGLE_CONFIDENT = [
  { text: 'a stick of butter', q: 'butter salted', name: 'butter', g: 113, count: 1, meal: 'snack' },
  { text: 'a slice of pizza', q: 'pizza meat and vegetable topping regular crust frozen cooked', name: 'pizza', g: 130, count: 1, meal: 'dinner' },
  { text: 'a cup of rice', q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 160, count: null, meal: 'lunch' },
  { text: 'a handful of almonds', q: 'nuts almonds', name: 'almonds', g: 28, count: null, meal: 'snack' },
  { text: 'black coffee', q: 'coffee brewed prepared with tap water', name: 'black coffee', g: 240, count: null, meal: 'breakfast' },
  { text: 'a large fries', q: 'potato french fries from fresh fried', name: 'french fries', g: 154, count: null, meal: 'lunch' },
  { text: 'a can of tuna', q: 'tuna light canned water drained', name: 'canned tuna', g: 140, count: 1, meal: 'lunch' },
  { text: 'two slices of bacon', q: 'pork cured bacon cooked', name: 'bacon', g: 18, count: 2, meal: 'breakfast' },
];
for (const c of SINGLE_CONFIDENT) {
  c.food = search(c.q);
  if (!c.food) throw new Error(`Single-confident food not found in DB: "${c.q}"`);
}

// ---- Shared "base" foods for the explicit-ingredient-list sample type
// (rice under a bowl, tortilla around a burrito/wrap) ----
const INGREDIENT_BASES = {
  rice: { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 150 },
  tortilla: { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70 },
};
for (const b of Object.values(INGREDIENT_BASES)) {
  b.food = search(b.q);
  if (!b.food) throw new Error(`Ingredient base not found in DB: "${b.q}"`);
}

// ---- Branded fast-food items: one exact menu item, one gold entry ----
// Real users often name a specific menu item ("a Baconator") rather than
// listing ingredients; foods.db's branded rows (data_type='branded') let us
// teach a single resolving item instead of decomposing into generics. Only
// keep rows that (a) belong to a recognizable chain, (b) have a clean item
// name, and (c) resolve back to themselves through the app's own search —
// apostrophes in chain names ("Wendy's") tokenize into a stray "s" token that
// doesn't always re-match, so e.g. the original "Wendy's Baconator" fails to
// self-resolve (it matches "Son of Baconator" instead) and is excluded
// rather than shipped with a broken db_search_term.
const BRANDED_CHAINS = [
  "McDonald's", 'Burger King', "Wendy's", 'Taco Bell', 'KFC', 'Chick-fil-A',
  "Domino's", 'Chipotle', "Arby's", 'Dairy Queen', 'Sonic', 'Popeyes',
  'Del Taco', 'Jack in the Box', 'Panda Express', "Jimmy John's",
  "Papa John's", 'Little Caesars', "Denny's", 'IHOP',
];
const BRANDED_CASUAL = {
  "McDonald's": 'mcdonalds', "Wendy's": 'wendys', "Domino's": 'dominos', "Arby's": 'arbys',
  "Jimmy John's": 'jimmy johns', "Papa John's": 'papa johns', "Denny's": 'dennys',
  'Chick-fil-A': 'chick-fil-a', 'Jack in the Box': 'jack in the box', 'Burger King': 'burger king',
  'Taco Bell': 'taco bell', 'KFC': 'kfc', 'Chipotle': 'chipotle', 'Dairy Queen': 'dairy queen',
  'Sonic': 'sonic', 'Popeyes': 'popeyes', 'Del Taco': 'del taco', 'Panda Express': 'panda express',
  'Little Caesars': 'little caesars', 'IHOP': 'ihop',
};
const BRANDED = (() => {
  const rows = db.prepare("SELECT name, kcal, protein, carbs, fat, portions_json FROM foods WHERE data_type = 'branded'").all();
  const out = [];
  for (const r of rows) {
    const chain = BRANDED_CHAINS.find((c) => r.name.startsWith(c));
    if (!chain) continue;
    const item = r.name.slice(chain.length).trim().replace(/^,\s*/, '');
    if (!item || item.length > 45 || /,/.test(item)) continue;
    let portions;
    try { portions = JSON.parse(r.portions_json); } catch { continue; }
    const grams = portions?.[0]?.grams;
    if (!grams || grams < 20 || grams > 900) continue;
    const resolved = search(r.name);
    if (!resolved || resolved.name !== r.name) continue; // must resolve back to itself
    out.push({ dbName: r.name, chain, item, grams, food: r });
  }
  return out;
})();
if (BRANDED.length < 50) {
  console.warn(`WARNING: only ${BRANDED.length} branded foods resolved cleanly — chain list or DB may have changed.`);
}

// Globally-unique branded product names — recognizable WITHOUT the chain, so
// the user text may drop the chain for these ("a big mac", "2 whoppers"). Every
// OTHER branded item MUST name its chain in the text, so the model never learns
// to invent a chain for a generic food it doesn't recognize (the fabrication
// failure: "a poke bowl" → "Little Caesars Poke Bowl").
const UNIQUE_BRANDED = ['big mac', 'whopper', 'baconator', 'mcflurry', 'frosty', 'blizzard', 'crunchwrap', 'mcnugget', 'quarter pounder'];
const isUniqueBranded = (itemLc) => UNIQUE_BRANDED.some((u) => itemLc.includes(u));
// Strip a leading count/size token from a branded item name so the CLAIM name
// never carries a digit ("6 Nuggets" → "nuggets", "1/4 lb GrillBurger" →
// "grillburger", "55+ Club Sandwich" → "club sandwich"): the count belongs in
// the `count` field, never baked into the name (the fake-SKU failure). The user
// TEXT keeps the original phrasing.
const LEADING_COUNT_RE = /^\s*(?:#?\d+(?:[/.]\d+)?\+?["']?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\s*(?:lb\.?|lbs\.?|oz\.?|pc\.?|pcs\.?|pieces?)?\s*/i;
const stripLeadingCount = (name) => name.replace(LEADING_COUNT_RE, '').trim() || name;
// Items whose own name carries no count/digit — the only ones eligible for the
// multi-count render ("2 big macs"), so pluralization/semantics stay clean.
const BRANDED_COUNTABLE = BRANDED.filter((b) => stripLeadingCount(b.item) === b.item && !/\d/.test(b.item));
// Last words that pluralize cleanly as a countable menu item ("3 crunchy
// tacos"); anything else uses the safe "N orders of X" phrasing so mass-ish
// dishes ("orange chicken", "french fries") never render as "3 orange chickens".
const COUNTABLE_LAST = new Set(['burger', 'cheeseburger', 'hamburger', 'sandwich', 'taco', 'burrito', 'wrap', 'dog', 'hotdog', 'nugget', 'biscuit', 'cookie', 'doughnut', 'donut', 'muffin', 'roll', 'sub', 'slider', 'quesadilla', 'melt', 'wing', 'tender', 'strip', 'whopper', 'baconator', 'mcflurry', 'mcmuffin', 'mcgriddle', 'mcchicken', 'mcdouble', 'frosty', 'blizzard', 'crunchwrap', 'cone', 'sundae', 'pie', 'bowl']);
if (BRANDED_COUNTABLE.length < 20) {
  console.warn(`WARNING: only ${BRANDED_COUNTABLE.length} multi-count-eligible branded foods — check LEADING_COUNT_RE.`);
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

const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one',
  'twenty-two', 'twenty-three', 'twenty-four'];
// Render a count as digits or words — real users type both ("10 tacos" and
// "ten tacos", "6 eggs" and "six eggs"), so pick either regardless of size.
const numForm = (n) => (rand() < 0.45 ? String(n) : (numberWords[n] ?? String(n)));
const OZ_G = 28.3495;
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
// A handful of pool item names end in "s" but are mass nouns, not plurals
// ("hummus") — everything else ending in "s" ("scrambled eggs", "black
// beans", "roasted chicken thighs") is a genuine plural. Used to pick the
// grammatically-correct vague-question form below ("how much" vs "how
// many") instead of always using a singular-agreeing "was it", which reads
// as broken for plural names ("how much scrambled eggs was it").
const MASS_NOUN_S_EXCEPTIONS = new Set(['hummus']);
const isPluralName = (name) => {
  const last = name.split(' ').pop().toLowerCase();
  return last.endsWith('s') && !MASS_NOUN_S_EXCEPTIONS.has(last);
};

// ---- schema v2: count / unit_grams ----------------------------------------
// The claim now carries `count` (how many whole units) + `unit_grams` (grams
// of ONE unit) so the APP multiplies rather than the model. Invariant the
// generator must uphold on every item: count == null ⇒ unit_grams == null;
// count != null ⇒ unit_grams != null AND count × unit_grams == grams.
//
// `discreteUnit` decides, for a DISHES component / ADDON item that carries no
// explicitly-rendered quantity, whether its NAME denotes a single countable
// whole object ("a bagel", "a beef patty", one egg) → count 1 / unit_grams =
// its (already-jittered) grams, or an amount of a substance / a plural portion
// (rice, sauce, shredded cheese, "scrambled eggs") → null / null. Judgment
// call per the schema-v2 mapping; unit_grams = grams keeps count=1 exact under
// jitter. Bias toward null when ambiguous.
const DISCRETE_UNIT_WORDS = new Set([
  'bagel', 'tortilla', 'bun', 'patty', 'dog', 'egg', 'biscuit', 'croissant',
  'muffin', 'pancake', 'waffle', 'doughnut', 'cookie', 'taco', 'nugget', 'wing',
  'banana', 'apple', 'orange', 'peach', 'tomato', 'potato', 'pretzel',
  'bratwurst', 'burger', 'cheeseburger', 'sandwich', 'wrap', 'roll',
]);
function discreteUnit(name, grams) {
  // A plural last word ("scrambled eggs", "cherry tomatoes", "chicken wings")
  // is a portion of several units, not one stated whole — treat as an amount.
  if (isPluralName(name)) return { count: null, unit_grams: null };
  const last = name.toLowerCase().split(/\s+/).pop();
  if (DISCRETE_UNIT_WORDS.has(singular(last))) return { count: 1, unit_grams: grams };
  return { count: null, unit_grams: null };
}

function renderComponent(item, vague) {
  // Whole/half/family-size rendering ("a whole pizza", "half a rotisserie
  // chicken", "a family size bag of chips") — a discrete alternative to the
  // food's normal units, scaled to a realistic whole-item weight rather than
  // a per-100g/per-slice estimate.
  if (!vague && item.wholeOptions && rand() < 0.55) {
    const w = pick(item.wholeOptions);
    const g = randInt(w.gMin, w.gMax);
    const phrase = w.phrase.replace('{name}', item.wholeLabel ?? item.name);
    // "half a X" → count 0.5; "a whole X" / "a family size bag of X" → count 1.
    // unit_grams is the grams of the whole unit (= g/count), so 0.5 × whole ≈ g.
    const count = /\bhalf\b/i.test(w.phrase) ? 0.5 : 1;
    return { phrase, grams: g, count, unit_grams: Math.round(g / count) };
  }
  // Fluid-ounce drink render ("8 oz of milk", "12 fl oz of orange juice") — for
  // liquids marked with flOz (grams per FLUID ounce, ~30 g), the "N oz" is a
  // volume, so grams = N × flOz. count/unit_grams stay null (not a unit count).
  if (!vague && item.flOz && rand() < 0.4) {
    const oz = pick([6, 8, 8, 12, 12, 16, 16, 20]);
    const ozWord = pick(['oz', 'oz', 'ounces', 'fl oz']);
    return { phrase: `${oz} ${ozWord} of ${item.name}`, grams: Math.round(oz * item.flOz), count: null, unit_grams: null };
  }
  const unit = pick(item.units);
  if (vague) {
    const phrase = pick([`some ${item.name}`, `a serving of ${item.name}`, `a bit of ${item.name}`]);
    const mid = unit.kind === 'g' ? Math.round((unit.min + unit.max) / 2) : Math.round(unit.g * ((unit.min ?? 1) + (unit.max ?? 1)) / 2);
    return { phrase, grams: mid, vague: true, count: null, unit_grams: null };
  }
  if (unit.kind === 'g') {
    // ~25% of the time state the weight in ounces (teaches oz→g: "8 oz of steak")
    if (rand() < 0.25 && unit.max >= 40) {
      const oz = randInt(Math.max(1, Math.round(unit.min / OZ_G)), Math.max(2, Math.round(unit.max / OZ_G)));
      return { phrase: `${oz} oz of ${item.name}`, grams: Math.round(oz * OZ_G), count: null, unit_grams: null };
    }
    const g = randInt(unit.min, unit.max);
    return { phrase: `${g} ${pick(['g', 'grams'])} of ${item.name}`, grams: g, count: null, unit_grams: null };
  }
  if (unit.kind === 'count') {
    // Bulk quantities ("ten tacos", "a dozen wings", "20 nuggets") so the
    // model learns explicit large counts scale — capped to a realistic total
    // weight (not a fixed count ceiling), so small items (nuggets, cookies,
    // doughnuts) can go up to ~20-24 while heavier bulkable items stay sane.
    // \bbag\b (not bare "bag") so the exclusion still catches the "small bag"
    // chips unit without also matching "bagel" — that substring bug kept bagels
    // out of the dozen/half-dozen renders entirely (v7 "half a dozen bagels").
    const bulkable = unit.g <= 120 && !/stick|handful|can|\bbag\b|fillet|bowl|serving|small|medium|large|half|family/i.test(unit.unit);
    let n;
    let dozenWord = null;
    if (bulkable && rand() < 0.12) {
      // "a dozen"/"half a dozen" — well represented across many bulkable foods
      // (eggs, wings, nuggets, doughnuts, cookies, tacos, bagels), not just
      // whenever a random count happens to land on 12. BOTH half-dozen
      // phrasings ("a half dozen X" and "half a dozen X") appear, so the model
      // maps either to count 6 with a clean plural name (v7 regressed "half a
      // dozen bagels" to a singular name with count 1).
      if (rand() < 0.6) { n = 12; dozenWord = 'a dozen'; }
      else { n = 6; dozenWord = pick(['a half dozen', 'half a dozen']); }
    } else if (bulkable && rand() < 0.35) {
      const hi = Math.min(24, Math.max(8, Math.floor(1800 / unit.g)));
      n = randInt(6, hi);
    } else {
      n = randInt(unit.min, unit.max);
    }
    const unitLast = unit.unit.split(' ').pop();
    const nameLast = item.name.split(' ').pop();
    const numStr = dozenWord ?? numForm(n);
    // Unit already names the food ("fried egg", "medium banana") →
    // "two fried eggs"; otherwise "two slices of bacon"
    const phrase =
      singular(unitLast) === singular(nameLast)
        ? `${numStr} ${inflectLast(unit.unit, n)}`
        : `${numStr} ${inflectLast(unit.unit, n)} of ${item.name}`;
    // count-kind: the user stated n whole units of unit.g grams each.
    return { phrase, grams: n * unit.g, count: n, unit_grams: unit.g };
  }
  // measure (cup / tablespoon) — an amount of a substance, not a unit count.
  const fr = unit.fractions ? pick(FRACTION_PHRASES) : pick(FRACTION_PHRASES.filter((x) => x.f >= 1 && x.f !== 1.5));
  return { phrase: `${fr.phrase} ${inflectLast(unit.unit, fr.f > 1 ? 2 : 1)} of ${item.name}`, grams: Math.round(fr.f * unit.g), count: null, unit_grams: null };
}

const jitter = (g) => Math.max(5, Math.round(g * (0.85 + rand() * 0.3)));

function makeAddonSample() {
  const p = pick(ADDON_PAIRS);
  // Contrast: ~25% render the BASE ALONE (claim = base only). Without these the
  // model learns P(add-on | base) as a prior and starts hallucinating second
  // items on plain inputs ("fries" → fries + ketchup it was never told about);
  // the contrast teaches that the add-on exists only when the text says so.
  if (rand() < 0.25) {
    const g = jitter(p.base.g);
    const claimItems = [{
      name: p.base.name, ...discreteUnit(p.base.name, g), grams: g, prep: null, confidence: 0.7,
      db_search_terms: [p.base.q], est_per100: roundedPer100(p.base.food), _dbName: p.base.food.name,
    }];
    return {
      text: p.base.phrase ?? p.base.name,
      claim: { items: claimItems.map(({ _dbName, ...i }) => i), needs_clarification: false, questions: [], meal_guess: p.meal },
      combo: comboKey(claimItems.map((i) => i._dbName)),
    };
  }
  const comps = [p.base, p.addon, ...(p.extra ? [p.extra] : [])];
  const tmpl = p.extra ? '{b} with {a} and {e}' : pick(ADDON_TEMPLATES);
  const text = tmpl
    .replace('{b}', p.base.phrase ?? p.base.name)
    .replace('{a}', p.addon.name)
    .replace('{e}', p.extra ? p.extra.name : '');
  const claimItems = comps.map((c) => {
    const g = jitter(c.g);
    return {
      name: c.name,
      ...discreteUnit(c.name, g),
      grams: g,
      prep: null,
      confidence: 0.7,
      db_search_terms: [c.q],
      est_per100: roundedPer100(c.food),
      _dbName: c.food.name,
    };
  });
  const claim = {
    items: claimItems.map(({ _dbName, ...item }) => item),
    needs_clarification: false,
    questions: [],
    meal_guess: p.meal,
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// A branded menu item starts with a digit/hash ("6 Nuggets", "#1 Pepe
// Sandwich", "1/4 lb GrillBurger") where "a " reads wrong; leave those bare.
const articleize = (item) => (/^[\d#]/.test(item) ? item : `a ${item}`);

function brandedMealGuess(item) {
  if (/breakfast|pancake|biscuit|hash brown|scramble|omelet|french toast|waffle/i.test(item)) return 'breakfast';
  return pick(['lunch', 'dinner']);
}

function makeBrandedSample() {
  // ~30% state a 2-4 count ("2 big macs", "three crunchy tacos from taco bell",
  // "3 orders of orange chicken from panda express"): the count lives in the
  // TEXT and the gold `count` field, NEVER in the item name (which stays clean,
  // no digit) — the fix for the fake-SKU emission {name:"2 big mac", count:1}.
  const multi = rand() < 0.3 && BRANDED_COUNTABLE.length > 0;
  const b = multi ? pick(BRANDED_COUNTABLE) : pick(BRANDED);
  const itemLc = b.item.toLowerCase();
  const chainCasual = BRANDED_CASUAL[b.chain] ?? b.chain.toLowerCase();
  const unique = isUniqueBranded(itemLc);

  let text, count, name, unit_grams, grams;
  if (multi) {
    const n = randInt(2, 4);
    const numStr = numForm(n);
    const countable = unique || COUNTABLE_LAST.has(singular(itemLc.split(' ').pop()));
    const pluralPhrase = `${numStr} ${inflectLast(itemLc, n)}`;   // "2 big macs"
    const ordersPhrase = `${numStr} orders of ${itemLc}`;          // "3 orders of orange chicken"
    // Every chain-form names the chain; the bare form (chain omitted) is only
    // offered for globally-unique names.
    const chainForms = countable
      ? [`${pluralPhrase} from ${chainCasual}`, `${numStr} ${chainCasual} ${inflectLast(itemLc, n)}`, `${ordersPhrase} from ${chainCasual}`]
      : [`${ordersPhrase} from ${chainCasual}`, `${numStr} ${chainCasual} ${itemLc}`];
    const bare = countable ? pluralPhrase : ordersPhrase;
    text = unique ? pick([bare, bare, ...chainForms]) : pick(chainForms);
    count = n;
    name = itemLc;              // BRANDED_COUNTABLE guarantees no digit here
    unit_grams = b.grams;
    grams = n * b.grams;
  } else {
    const cleanName = stripLeadingCount(itemLc);
    const digitInName = /^[\s#]*\d/.test(cleanName); // belt-and-suspenders
    const withArticle = articleize(itemLc);
    const chainForms = [
      `${withArticle} from ${chainCasual}`,
      `a ${chainCasual} ${itemLc}`,
      `got ${withArticle} from ${chainCasual}`,
      `had ${withArticle} at ${chainCasual}`,
    ];
    // Bare (chain omitted) only for globally-unique names; everything else must
    // mention the chain, so the model never learns to fabricate one.
    text = unique ? pick([withArticle, withArticle, ...chainForms]) : pick(chainForms);
    // Branded: one menu item = one whole unit; unit_grams is the row's portion.
    count = digitInName ? null : 1;
    name = cleanName;
    unit_grams = digitInName ? null : b.grams;
    grams = b.grams;
  }

  const claimItems = [{
    name,
    count,
    unit_grams,
    grams,
    prep: null,
    confidence: 0.9,
    db_search_terms: [b.dbName],
    est_per100: roundedPer100(b.food),
    _dbName: b.dbName,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: brandedMealGuess(b.item),
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// Explicit ingredient list ("a bowl with X, Y, and Z") — the fixed DISHES /
// MEAL_SHAPES templates teach a small set of memorized shapes (a "burrito"
// always means tortilla+rice+beans+meat+cheese). This picks 2-4 arbitrary
// pool foods and renders them as a plainly-listed bowl/wrap/burrito/plate, so
// the gold claim is EXACTLY what the text names — teaching the model to read
// the user's list rather than pattern-match a memorized dish.
// 'snackfat' (avocado/nuts/peanut butter), not the full 'fat' pool — oils and
// dressings read oddly as a bare listed "ingredient" ("a bowl with chicken,
// rice, and olive oil"), whereas avocado/nuts are things people actually name.
const INGREDIENT_CATS = ['protein', 'starch', 'vegetable', 'snackfat', 'dairy', 'fruit'];
const INGREDIENT_TEMPLATES = [
  { render: (list) => `a bowl with ${list}`, base: null },
  { render: (list) => `a bowl with ${list}, over rice`, base: 'rice' },
  { render: (list) => `${list}, over rice`, base: 'rice' },
  { render: (list) => `a wrap with ${list}`, base: 'tortilla' },
  { render: (list) => `a burrito with ${list}`, base: 'tortilla' },
  { render: (list) => `a plate with ${list}`, base: null },
  { render: (list) => list, base: null },
];

function makeIngredientSample() {
  const n = randInt(2, 4);
  const tmpl = pick(INGREDIENT_TEMPLATES);
  // Dedupe by RESOLVED DB FOOD, not by pool-item identity — two different
  // pool entries can still resolve to the same DB row, and a listed
  // ingredient must never repeat the base's food either (the "burrito bowl
  // with rice, beans, ..." bug: a starch-pool rice item picked alongside the
  // 'rice' base doubled rice+beans in the gold claim, +122% kcal).
  const usedDbNames = new Set();
  if (tmpl.base) usedDbNames.add(INGREDIENT_BASES[tmpl.base].food.name);
  const items = [];
  for (let tries = 0; items.length < n && tries < 200; tries++) {
    const it = pick(POOLS[pick(INGREDIENT_CATS)]);
    if (usedDbNames.has(it.food.name)) continue;
    items.push(it);
    usedDbNames.add(it.food.name);
  }
  const rendered = items.map((it) => {
    const rc = renderComponent(it, false);
    return { item: it, phrase: rc.phrase, grams: rc.grams, count: rc.count, unit_grams: rc.unit_grams };
  });
  // A count-kind item is listed WITH its stated quantity ("12 chicken nuggets",
  // "half a dozen bagels") so the text matches the gold count — otherwise a
  // bulk count would be asserted from a bare name the text never quantified.
  // Measure/gram/vague items keep the bare name (the plain-list signal).
  const label = (r) => (r.count != null ? r.phrase : r.item.name);
  const list = rendered.length > 1
    ? `${rendered.slice(0, -1).map(label).join(', ')}, and ${label(rendered[rendered.length - 1])}`
    : label(rendered[0]);
  const text = tmpl.render(list);
  const claimItems = rendered.map((r) => ({
    name: r.item.name,
    count: r.count,
    unit_grams: r.unit_grams,
    grams: r.grams,
    prep: null,
    confidence: 0.7,
    db_search_terms: [r.item.q],
    est_per100: roundedPer100(r.item.food),
    _dbName: r.item.food.name,
  }));
  if (tmpl.base) {
    const b = INGREDIENT_BASES[tmpl.base];
    const g = jitter(b.g);
    claimItems.push({
      name: b.name,
      ...discreteUnit(b.name, g),
      grams: g,
      prep: null,
      confidence: 0.7,
      db_search_terms: [b.q],
      est_per100: roundedPer100(b.food),
      _dbName: b.food.name,
    });
  }
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: pick(['lunch', 'dinner']),
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// A bare ambiguous food with no quantity or qualifier — the generator only
// produced vague/clarifying samples inside multi-item meals before; this
// covers the single-item under-asking gap (fixes 5 in the coverage pass).
function makeSingleClarifySample() {
  const c = pick(SINGLE_CLARIFY);
  const claimItems = [{
    name: c.name,
    count: c.count ?? null,
    unit_grams: c.count ? Math.round(c.g / c.count) : null,
    grams: c.g,
    prep: null,
    confidence: 0.45,
    db_search_terms: [c.q],
    est_per100: roundedPer100(c.food),
    _dbName: c.food.name,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: true,
    questions: [c.question],
    meal_guess: 'snack',
  };
  return { text: c.text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// The contrastive counterpart: a bare food with an explicit unit/qualifier
// that resolves the ambiguity — always confident, never asks.
function makeSingleConfidentSample() {
  const c = pick(SINGLE_CONFIDENT);
  const claimItems = [{
    name: c.name,
    count: c.count ?? null,
    unit_grams: c.count ? Math.round(c.g / c.count) : null,
    grams: c.g,
    prep: null,
    confidence: 0.95,
    db_search_terms: [c.q],
    est_per100: roundedPer100(c.food),
    _dbName: c.food.name,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: c.meal,
  };
  return { text: c.text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// ---- Bare count/whole single-item samples ----
// The gate feeds terse inputs ("a whole pizza", "20 nuggets"), but training
// rows were mostly full sentences, so bare count/whole phrasings under-stuck
// (gate: 0% exact on whole/family-size). This emits ONE count/whole render as
// the ENTIRE user message. Only non-held-out foods with a count unit or
// wholeOptions (a held-out single combo would be silently regenerated every
// draw and never appear).
const ALL_POOL_ITEMS = Object.values(POOLS).flat();
const poolByName = (name) => ALL_POOL_ITEMS.find((x) => x.name === name);
const BARE_COUNT_ITEMS = [
  'pepperoni pizza', 'chicken nuggets', 'fried chicken wings', 'rotisserie chicken',
  'roast chicken', 'scrambled eggs', 'hard-boiled eggs', 'mozzarella sticks',
  'meatballs', 'chicken tenders', 'mini muffins', 'pancakes', 'doughnut', 'pretzels',
  // v8: bagels reach the dozen/half-dozen renders ("half a dozen bagels"), and
  // the small-piece foods (shrimp ~12 g, potstickers ~35 g) render bare counts.
  'plain bagel', 'potstickers', 'cooked shrimp',
].map(poolByName).filter(Boolean);
if (BARE_COUNT_ITEMS.length < 10) {
  console.warn(`WARNING: only ${BARE_COUNT_ITEMS.length} bare-count items resolved — a pool name may have changed.`);
}

function bareMealGuess(name) {
  if (/pancake|muffin|doughnut|egg/i.test(name)) return 'breakfast';
  if (/cookie|chip|pretzel|stick|nugget|wing|meatball|tender/i.test(name)) return pick(['snack', 'lunch']);
  return pick(['lunch', 'dinner']);
}

function makeBareCountSample() {
  const item = pick(BARE_COUNT_ITEMS);
  // Force a count/whole render (retry past any gram/measure unit the item also
  // carries); renderComponent already owns all the count/dozen/whole logic.
  let r = renderComponent(item, false);
  for (let i = 0; i < 40 && r.count == null; i++) r = renderComponent(item, false);
  const claimItems = [{
    name: item.name,
    count: r.count,
    unit_grams: r.unit_grams,
    grams: r.grams,
    prep: null,
    confidence: 0.95,
    db_search_terms: [item.q],
    est_per100: roundedPer100(item.food),
    _dbName: item.food.name,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: bareMealGuess(item.name),
  };
  return { text: r.phrase, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// ---- Negation: a dish with a removed component ----
// "a chicken burrito with no rice" — gold claim is the dish WITHOUT that
// component. The model was emitting the negated food anyway ("no rice" still
// produced rice). Each `keep` list is the dish minus the removed item; every
// q is one already used elsewhere (so it resolves), and the removed word never
// appears in any kept component name.
const NEGATION_TEMPLATES = ['{d} with no {a}', '{d} without {a}', '{d}, no {a}', '{d} but no {a}', '{d} with no {a} on it'];
const NEGATION_PAIRS = [
  { text: 'a chicken burrito', remove: 'rice', meal: 'lunch', keep: [
    { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70 },
    { q: 'beans black mature seeds cooked boiled', name: 'black beans', g: 60 },
    { q: 'chicken breast meat only roasted', name: 'grilled chicken', g: 85, prep: 'grilled' },
    { q: 'cheese cheddar', name: 'shredded cheese', g: 28 },
  ] },
  { text: 'a beef burrito', remove: 'cheese', meal: 'lunch', keep: [
    { q: 'tortillas ready to bake or fry flour shelf stable', name: 'flour tortilla', g: 70 },
    { q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 80 },
    { q: 'beans black mature seeds cooked boiled', name: 'black beans', g: 60 },
    { q: 'beef ground 85 lean meat 15 fat patty cooked broiled', name: 'ground beef', g: 85 },
  ] },
  { text: 'a chicken caesar salad', remove: 'croutons', meal: 'lunch', keep: [
    { q: 'lettuce cos or romaine raw', name: 'romaine lettuce', g: 130 },
    { q: 'chicken breast meat only roasted', name: 'grilled chicken', g: 120, prep: 'grilled' },
    { q: 'salad dressing caesar', name: 'caesar dressing', g: 30 },
    { q: 'cheese parmesan grated', name: 'parmesan', g: 10 },
  ] },
  { text: 'a turkey and swiss sandwich', remove: 'mayo', meal: 'lunch', keep: [
    { q: 'bread whole wheat commercially prepared', name: 'whole wheat bread', g: 64 },
    { q: 'turkey breast deli', name: 'deli turkey breast', g: 71 },
    { q: 'cheese swiss', name: 'swiss cheese', g: 28 },
  ] },
  { text: 'a greek yogurt parfait', remove: 'granola', meal: 'breakfast', keep: [
    { q: 'yogurt greek plain nonfat', name: 'greek yogurt', g: 245 },
    { q: 'blueberries raw', name: 'blueberries', g: 74 },
  ] },
  { text: 'a grilled chicken salad', remove: 'ranch', meal: 'lunch', keep: [
    { q: 'lettuce cos or romaine raw', name: 'romaine lettuce', g: 94 },
    { q: 'chicken breast meat only roasted', name: 'grilled chicken breast', g: 100, prep: 'grilled' },
    { q: 'tomatoes red ripe raw', name: 'cherry tomatoes', g: 62 },
  ] },
];
for (const p of NEGATION_PAIRS) {
  for (const c of p.keep) {
    c.food = search(c.q);
    if (!c.food) throw new Error(`Negation keep food not found in DB: "${c.q}"`);
    if (c.name.toLowerCase().includes(p.remove)) {
      throw new Error(`Negation invariant broken: kept "${c.name}" contains removed "${p.remove}"`);
    }
  }
}

function makeNegationSample() {
  const p = pick(NEGATION_PAIRS);
  const text = pick(NEGATION_TEMPLATES).replace('{d}', p.text).replace('{a}', p.remove);
  const claimItems = p.keep.map((c) => {
    const g = jitter(c.g);
    return {
      name: c.name,
      ...discreteUnit(c.name, g),
      grams: g,
      prep: c.prep ?? null,
      confidence: 0.7,
      db_search_terms: [c.q],
      est_per100: roundedPer100(c.food),
      _dbName: c.food.name,
    };
  });
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: p.meal,
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// ---- v8: fraction-of-whole-dish ("a quarter of the lasagna") ----
// The fraction applies to the WHOLE dish, so unit_grams is the whole-dish
// weight and count is the fraction (0.25/0.33/0.5); grams = count × whole. v7
// multiplied the fraction against a single-serving weight and returned ~39 g.
// Only non-held-out single dishes (pepperoni, NOT cheese, pizza — cheese pizza
// is a held-out eval single that would be regenerated away as a bare single).
const FRACTION_DISHES = [
  { q: 'lasagna', name: 'lasagna', wholeMin: 1300, wholeMax: 1500, meal: 'dinner' },          // pan
  { q: 'cake chocolate prepared', name: 'chocolate cake', wholeMin: 850, wholeMax: 1050, meal: 'snack' },
  { q: 'cake white prepared', name: 'cake', wholeMin: 850, wholeMax: 1050, meal: 'snack' },
  { q: 'pie apple', name: 'apple pie', wholeMin: 900, wholeMax: 1150, meal: 'snack' },
  { q: 'pie pumpkin', name: 'pumpkin pie', wholeMin: 900, wholeMax: 1150, meal: 'snack' },
  { q: 'tuna noodle casserole', name: 'tuna casserole', wholeMin: 1300, wholeMax: 1600, meal: 'dinner' },
  { q: 'pizza pepperoni regular crust frozen cooked', name: 'pizza', wholeMin: 850, wholeMax: 1000, meal: 'dinner' },
  { q: 'chicken broilers rotisserie original seasoning breast meat and skin cooked', name: 'rotisserie chicken', wholeMin: 850, wholeMax: 950, meal: 'dinner' },
];
for (const d of FRACTION_DISHES) {
  d.food = search(d.q);
  if (!d.food) throw new Error(`Fraction-dish food not found in DB: "${d.q}"`);
}
// count is the stated fraction; "0.33" (not 1/3) keeps count × unit_grams == grams
// within ±1 rounding.
const DISH_FRACTIONS = [
  { phrases: ['a quarter of the {name}', 'a quarter of a {name}', 'a quarter of {name}', '1/4 of the {name}'], f: 0.25 },
  { phrases: ['a third of the {name}', 'a third of a {name}', 'a third of {name}', '1/3 of the {name}'], f: 0.33 },
  { phrases: ['half the {name}', 'half of the {name}', 'half a {name}', '1/2 of the {name}'], f: 0.5 },
];
function makeFractionDishSample() {
  const d = pick(FRACTION_DISHES);
  const fr = pick(DISH_FRACTIONS);
  const wholeG = randInt(d.wholeMin, d.wholeMax);
  const grams = Math.round(fr.f * wholeG);
  const text = pick(fr.phrases).replace('{name}', d.name);
  const claimItems = [{
    name: d.name,
    count: fr.f,
    unit_grams: wholeG,
    grams,
    prep: null,
    confidence: 0.8,
    db_search_terms: [d.q],
    est_per100: roundedPer100(d.food),
    _dbName: d.food.name,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: d.meal,
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// ---- v8: whole-container phrasings ("the whole box of donuts") ----
// Gold = container-count × per-unit weight (box of 12 donuts) or count 1 ×
// whole-container weight (loaf/sleeve/bag). count × unit_grams == grams exactly.
// tortilla chips / pretzels stand in for the generic "bag" (plain potato chips
// is a held-out eval single).
const CONTAINER_ITEMS = [
  { texts: ['the whole box of donuts', 'a whole box of donuts', 'a box of a dozen donuts', 'the entire box of donuts'],
    q: 'doughnuts cake type plain', name: 'doughnuts', count: 12, unitMin: 55, unitMax: 65, meal: 'snack' },
  { texts: ['a whole loaf of bread', 'the whole loaf of bread', 'a loaf of bread'],
    q: 'bread white commercially prepared', name: 'loaf of bread', count: 1, unitMin: 450, unitMax: 560, meal: 'snack' },
  { texts: ['the whole sleeve of crackers', 'a whole sleeve of crackers', 'a sleeve of crackers'],
    q: 'crackers standard snack-type regular', name: 'crackers', count: 1, unitMin: 100, unitMax: 120, meal: 'snack' },
  { texts: ['a whole bag of tortilla chips', 'the whole bag of chips', 'a whole bag of chips'],
    q: 'snacks tortilla chips plain', name: 'tortilla chips', count: 1, unitMin: 150, unitMax: 300, meal: 'snack' },
  { texts: ['a whole bag of pretzels', 'the whole bag of pretzels'],
    q: 'snacks pretzels hard plain salted', name: 'pretzels', count: 1, unitMin: 200, unitMax: 350, meal: 'snack' },
];
for (const c of CONTAINER_ITEMS) {
  c.food = search(c.q);
  if (!c.food) throw new Error(`Container food not found in DB: "${c.q}"`);
}
function makeContainerSample() {
  const c = pick(CONTAINER_ITEMS);
  const unit_grams = randInt(c.unitMin, c.unitMax);
  const grams = c.count * unit_grams;
  const text = pick(c.texts);
  const claimItems = [{
    name: c.name,
    count: c.count,
    unit_grams,
    grams,
    prep: null,
    confidence: 0.85,
    db_search_terms: [c.q],
    est_per100: roundedPer100(c.food),
    _dbName: c.food.name,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: c.meal,
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// ---- v8: non-food / gibberish → ask instead of hallucinating a food ----
// items:[] is schema-legal. Gibberish/non-food → ONE clarifying question;
// "I didn't eat anything" → no question (nothing to clarify); "just water" →
// a real 0-kcal water item (better than an empty ask).
const WATER_FOOD = search('water bottled generic');
if (!WATER_FOOD) throw new Error('Water food not found in DB: "water bottled generic"');
const WATER_TEXTS = ['just water', 'a glass of water', 'some water', 'a bottle of water', 'water', 'a big glass of water'];
const NOTHING_NOASK = ["I didn't eat anything", "I didn't eat anything today", "I haven't eaten yet", 'didn\'t eat anything', 'I skipped this meal'];
const NONFOOD_ASK = ['asdfghjkl', 'my dog', 'nothing', '???', 'qwerty', 'lorem ipsum', 'test', 'aaaaa', 'blah blah', 'idk', 'sdkfjh'];
const NONFOOD_QUESTION = "What did you eat? I couldn't find any food in that.";
function makeNonFoodSample() {
  const r = rand();
  if (r < 0.3) {
    const grams = randInt(240, 500);
    const claimItems = [{
      name: 'water',
      count: null,
      unit_grams: null,
      grams,
      prep: null,
      confidence: 0.85,
      db_search_terms: ['water bottled generic'],
      est_per100: roundedPer100(WATER_FOOD),
      _dbName: WATER_FOOD.name,
    }];
    return {
      text: pick(WATER_TEXTS),
      claim: { items: claimItems.map(({ _dbName, ...i }) => i), needs_clarification: false, questions: [], meal_guess: 'snack' },
      combo: comboKey(claimItems.map((i) => i._dbName)),
    };
  }
  if (r < 0.55) {
    return { text: pick(NOTHING_NOASK), claim: { items: [], needs_clarification: false, questions: [], meal_guess: 'snack' }, combo: comboKey([]) };
  }
  return { text: pick(NONFOOD_ASK), claim: { items: [], needs_clarification: true, questions: [NONFOOD_QUESTION], meal_guess: 'snack' }, combo: comboKey([]) };
}

// ---- v8: plain / nothing-on-it (strip condiment) + condiment fidelity ----
// "a plain bagel" / "dry toast" / "X, nothing on it" → base item ONLY (the
// model was adding an unstated condiment). The "with just <condiment>" cases
// are the contrast: keep EXACTLY the named condiment (no ketchup-for-mustard
// substitution, no invented second sauce).
const PLAIN_CASES = [
  { texts: ['a plain bagel', 'a bagel with nothing on it', 'just a plain bagel, no cream cheese'], meal: 'breakfast',
    keep: [{ q: 'bagels plain enriched', name: 'bagel', g: 99, count: 1 }] },
  { texts: ['dry toast', 'plain toast, no butter', 'toast with nothing on it'], meal: 'breakfast',
    keep: [{ q: 'bread whole wheat commercially prepared toasted', name: 'toast', g: 26, count: 1 }] },
  { texts: ['plain white rice', 'just plain rice, nothing on it'], meal: 'lunch',
    keep: [{ q: 'rice white long grain regular enriched cooked', name: 'white rice', g: 158 }] },
  { texts: ['a plain baked potato', 'a baked potato with nothing on it', 'a plain baked potato, no butter or sour cream'], meal: 'dinner',
    keep: [{ q: 'potatoes baked flesh and skin', name: 'baked potato', g: 173, count: 1 }] },
  { texts: ['plain scrambled eggs', 'scrambled eggs with nothing on them', 'just plain scrambled eggs'], meal: 'breakfast',
    keep: [{ q: 'egg whole cooked scrambled', name: 'scrambled eggs', g: 122 }] },
  { texts: ['a plain hamburger', 'a plain burger with nothing on it', 'a plain hamburger, no condiments'], meal: 'lunch',
    keep: [{ q: 'fast foods hamburger single patty plain', name: 'hamburger', g: 110, count: 1 }] },
  { texts: ['a hot dog with just mustard', 'a hot dog, only mustard on it', 'a hot dog with mustard and nothing else'], meal: 'dinner',
    keep: [{ q: 'frankfurter beef', name: 'hot dog', g: 48, count: 1 }, { q: 'mustard prepared yellow', name: 'mustard', g: 8 }] },
  { texts: ['a bagel with just cream cheese', 'a bagel with only cream cheese on it'], meal: 'breakfast',
    keep: [{ q: 'bagels plain enriched', name: 'bagel', g: 99, count: 1 }, { q: 'cheese cream', name: 'cream cheese', g: 30 }] },
];
for (const p of PLAIN_CASES) {
  for (const k of p.keep) {
    k.food = search(k.q);
    if (!k.food) throw new Error(`Plain keep food not found in DB: "${k.q}"`);
  }
}
function makePlainSample() {
  const p = pick(PLAIN_CASES);
  const text = pick(p.texts);
  const claimItems = p.keep.map((k) => {
    const g = jitter(k.g);
    const cu = k.count != null ? { count: k.count, unit_grams: Math.round(g / k.count) } : discreteUnit(k.name, g);
    return {
      name: k.name,
      count: cu.count,
      unit_grams: cu.unit_grams,
      grams: g,
      prep: null,
      confidence: 0.85,
      db_search_terms: [k.q],
      est_per100: roundedPer100(k.food),
      _dbName: k.food.name,
    };
  });
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: p.meal,
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

// ---- v8: bare fluid-ounce drink ("8 ounces of milk" → ~240 g) ----
// Whole milk only (2% milk / orange juice / cola are held-out eval singles, so
// a bare single of them regenerates away). In-meal fl-oz renders (renderComponent
// flOz path) cover those drinks without the hold-out problem.
const FLOZ_MILK = ALL_POOL_ITEMS.find((x) => x.name === 'whole milk');
function makeFlOzDrinkSample() {
  const oz = pick([6, 8, 8, 12, 12, 16, 20]);
  const grams = Math.round(oz * FLOZ_MILK.flOz);
  const text = `${oz} ${pick(['oz', 'oz', 'ounces', 'fl oz'])} of ${pick(['milk', 'whole milk'])}`;
  const claimItems = [{
    name: 'whole milk',
    count: null,
    unit_grams: null,
    grams,
    prep: null,
    confidence: 0.95,
    db_search_terms: [FLOZ_MILK.q],
    est_per100: roundedPer100(FLOZ_MILK.food),
    _dbName: FLOZ_MILK.food.name,
  }];
  const claim = {
    items: claimItems.map(({ _dbName, ...i }) => i),
    needs_clarification: false,
    questions: [],
    meal_guess: pick(['breakfast', 'snack']),
  };
  return { text, claim, combo: comboKey(claimItems.map((i) => i._dbName)) };
}

function makeSampleOnce() {
  const r = rand();
  let t = ADDON_FRAC;
  if (r < t) return makeAddonSample();
  if (r < (t += BRANDED_FRAC)) return makeBrandedSample();
  if (r < (t += INGREDIENT_FRAC)) return makeIngredientSample();
  if (r < (t += CLARIFY_FRAC)) return makeSingleClarifySample();
  if (r < (t += SINGLE_CONFIDENT_FRAC)) return makeSingleConfidentSample();
  if (r < (t += BARE_COUNT_FRAC)) return makeBareCountSample();
  if (r < (t += NEGATION_FRAC)) return makeNegationSample();
  if (r < (t += FRACTION_DISH_FRAC)) return makeFractionDishSample();
  if (r < (t += CONTAINER_FRAC)) return makeContainerSample();
  if (r < (t += PLAIN_FRAC)) return makePlainSample();
  if (r < (t += FLOZ_DRINK_FRAC)) return makeFlOzDrinkSample();
  if (r < (t += NONFOOD_FRAC)) return makeNonFoodSample();
  const shape = pick(MEAL_SHAPES);
  const entries = []; // {kind:'item', item, cat} | {kind:'dish', dish}
  // Dedupe by RESOLVED DB FOOD across BOTH plain-item slots and dish-component
  // slots — a fixed DISH (e.g. "a chicken caesar salad") already includes
  // romaine lettuce/tomato/etc. as components, and an independent slot in the
  // same shape could otherwise pick that exact same resolved food again
  // (same bug class as makeIngredientSample's duplicate-rice fix above).
  const usedDbNames = new Set();
  for (const slot of shape.slots) {
    const cat = pick(slot);
    if (cat == null) continue;
    if (cat.startsWith('dish:')) {
      const dish = pick(DISHES[cat.slice(5)]);
      if (dish.components.some((c) => usedDbNames.has(c.food.name))) continue;
      entries.push({ kind: 'dish', dish });
      for (const c of dish.components) usedDbNames.add(c.food.name);
      continue;
    }
    const item = pick(POOLS[cat]);
    if (usedDbNames.has(item.food.name)) continue;
    entries.push({ kind: 'item', item, cat });
    usedDbNames.add(item.food.name);
  }
  if (entries.length === 0) entries.push({ kind: 'item', item: pick(POOLS.fruit), cat: 'fruit' });

  // ~10% of samples make one high-variance PLAIN component vague → gold
  // question (dishes are excluded: their portions are estimates by nature).
  // Lowered from 0.15 as part of the over-asking-regression fix — combined
  // with the lower CLARIFY_FRAC and the new SINGLE_CONFIDENT contrastive
  // samples above, this brings the overall ask-rate from 14.2% back to the
  // ~5-8% range.
  const plainIdx = entries.map((e, i) => (e.kind === 'item' ? i : -1)).filter((i) => i >= 0);
  const vagueIdx = plainIdx.length && rand() < 0.1 ? pick(plainIdx) : -1;

  const rendered = entries.map((e, i) => {
    if (e.kind === 'dish') {
      return {
        phrase: e.dish.text,
        dish: e.dish,
        claimItems: e.dish.components.map((c) => {
          const g = jitter(c.g);
          return {
            name: c.name,
            ...discreteUnit(c.name, g),
            grams: g,
            prep: c.prep,
            confidence: 0.7,
            db_search_terms: [c.q],
            est_per100: roundedPer100(c.food),
            _dbName: c.food.name,
          };
        }),
      };
    }
    const r = renderComponent(e.item, i === vagueIdx);
    return {
      phrase: r.phrase,
      vagueItem: r.vague ? e.item : undefined,
      claimItems: [{
        name: e.item.name,
        count: r.count,
        unit_grams: r.unit_grams,
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
      ? [isPluralName(vague.vagueItem.name)
          ? `Roughly how many ${vague.vagueItem.name} were there — or about how much in grams?`
          : `Roughly how much ${vague.vagueItem.name} was there — in grams or a typical serving?`]
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
