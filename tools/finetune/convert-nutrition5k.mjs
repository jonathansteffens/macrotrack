// Converts the Nutrition5k slice fetched by fetch-nutrition5k.sh into
// image→FoodClaim SFT examples. Labels are measured ground truth, never
// model-guessed: grams are the dataset's per-ingredient masses, est_per100
// is derived from the dataset's per-ingredient macros (USDA-based), and
// db_search_terms is the ingredient name.
//
//   node tools/finetune/convert-nutrition5k.mjs [--data data/nutrition5k] [--out-dir data/nutrition5k]
//
// Writes n5k-train.jsonl and n5k-test.jsonl following the OFFICIAL rgb
// train/test split. The test file is an eval set — never train on it.
//
// Each line: { image: <path relative to repo root>, dish_id, totals,
//   messages: [system, user, assistant] } — the user turn is the app's
// photo-only default text; the training script attaches the image.
//
// Dishes are filtered for known label problems (zero/absurd mass or kcal).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const DATA = arg('data', join(ROOT, 'data', 'nutrition5k'));
const OUT_DIR = arg('out-dir', DATA);

const SYSTEM_PROMPT = readFileSync(join(ROOT, 'mobile', 'src', 'lib', 'ai', 'prompt.ts'), 'utf8')
  .match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
// The app's photo-only user text (mobile/src/lib/ai/estimator.ts)
const PHOTO_ONLY_TEXT = 'Estimate the nutrition of this meal.';

// dish_metadata_cafe*.csv is a ragged CSV:
// dish_id, total_cal, total_mass, total_fat, total_carb, total_protein,
// then per ingredient: id, name, grams, cal, fat, carb, protein
function parseDishes(file) {
  const dishes = [];
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const f = line.split(',');
    if (f.length < 13) continue;
    const dish = {
      id: f[0].trim(),
      kcal: parseFloat(f[1]),
      mass: parseFloat(f[2]),
      fat: parseFloat(f[3]),
      carbs: parseFloat(f[4]),
      protein: parseFloat(f[5]),
      ingredients: [],
    };
    for (let i = 6; i + 6 < f.length; i += 7) {
      const grams = parseFloat(f[i + 2]);
      if (!(grams > 1)) continue; // skip trace ingredients
      dish.ingredients.push({
        name: f[i + 1].trim().toLowerCase(),
        grams,
        kcal: parseFloat(f[i + 3]),
        fat: parseFloat(f[i + 4]),
        carbs: parseFloat(f[i + 5]),
        protein: parseFloat(f[i + 6]),
      });
    }
    dishes.push(dish);
  }
  return dishes;
}

const round1 = (x) => Math.round(x * 10) / 10;

function toSample(dish, imagePath) {
  const items = dish.ingredients.map((ing) => ({
    name: ing.name,
    grams: round1(ing.grams),
    prep: null,
    // photo-estimated portions: solid identification, estimated amounts
    confidence: 0.7,
    db_search_terms: [ing.name],
    est_per100: {
      kcal: round1((ing.kcal / ing.grams) * 100),
      protein: round1((ing.protein / ing.grams) * 100),
      carbs: round1((ing.carbs / ing.grams) * 100),
      fat: round1((ing.fat / ing.grams) * 100),
    },
  }));
  const claim = {
    items,
    needs_clarification: false,
    questions: [],
    meal_guess: 'lunch', // cafeteria plates; meal type is not scored on photos
  };
  return {
    image: relative(ROOT, imagePath),
    dish_id: dish.id,
    totals: { kcal: round1(dish.kcal), mass: round1(dish.mass), protein: round1(dish.protein), carbs: round1(dish.carbs), fat: round1(dish.fat) },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: PHOTO_ONLY_TEXT },
      { role: 'assistant', content: JSON.stringify(claim) },
    ],
  };
}

// ---- Eval hold-out (same rule as generate-synthetic.mjs): a training dish
// whose resolved DB food set equals an eval case's combo is dropped. ----
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
      `SELECT name FROM foods WHERE ${where}
       ORDER BY CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT 1`
    )
    .get(...params, `${tokens[0]}%`);
}
const resolveCache = new Map();
const resolveName = (t) => {
  if (!resolveCache.has(t)) resolveCache.set(t, search(t)?.name ?? `?${t}`);
  return resolveCache.get(t);
};
const comboKey = (names) => [...new Set(names)].sort().join(' | ');
const EVAL_COMBOS = new Set(
  readFileSync(join(ROOT, 'tools', 'eval', 'cases.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => comboKey(JSON.parse(l).truth.map((t) => t.name)))
);

const dishes = [
  ...parseDishes(join(DATA, 'metadata', 'dish_metadata_cafe1.csv')),
  ...parseDishes(join(DATA, 'metadata', 'dish_metadata_cafe2.csv')),
];
const byId = new Map(dishes.map((d) => [d.id, d]));

const splits = {
  train: readFileSync(join(DATA, 'splits', 'rgb_train_ids.txt'), 'utf8'),
  test: readFileSync(join(DATA, 'splits', 'rgb_test_ids.txt'), 'utf8'),
};

let dropped = { noMeta: 0, noImage: 0, badLabel: 0, noIngredients: 0, evalCombo: 0 };
for (const [split, idsText] of Object.entries(splits)) {
  const out = [];
  for (const id of idsText.trim().split('\n').map((l) => l.trim()).filter(Boolean)) {
    const dish = byId.get(id);
    if (!dish) { dropped.noMeta++; continue; }
    const imagePath = join(DATA, 'overhead', `${id}.png`);
    if (!existsSync(imagePath)) { dropped.noImage++; continue; }
    // known dataset label issues: implausible totals
    if (!(dish.mass >= 10 && dish.kcal > 0 && dish.kcal < 4000)) { dropped.badLabel++; continue; }
    if (dish.ingredients.length === 0) { dropped.noIngredients++; continue; }
    if (split === 'train' && EVAL_COMBOS.has(comboKey(dish.ingredients.map((i) => resolveName(i.name))))) {
      dropped.evalCombo++;
      continue;
    }
    out.push(toSample(dish, imagePath));
  }
  const file = join(OUT_DIR, `n5k-${split}.jsonl`);
  writeFileSync(file, out.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log(`${split}: ${out.length} samples → ${file}`);
}
console.log('dropped:', dropped);
