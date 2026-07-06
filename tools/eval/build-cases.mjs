// Builds eval/cases.jsonl: natural-language meal descriptions with ground
// truth computed from the bundled USDA database — so the estimator is scored
// against the same canonical data the app resolves to.
//
// Usage: node tools/eval/build-cases.mjs   (writes tools/eval/cases.jsonl)

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', '..', 'mobile', 'assets', 'foods.db'), {
  readOnly: true,
});

// Each case: what a user would type + the exact DB foods and grams it means.
// `query` is resolved with the app's search ranking; build fails loudly if a
// query resolves to nothing so bad ground truth can't slip in silently.
const SPECS = [
  {
    id: 'chicken-rice',
    text: '150 g of roasted chicken breast and a cup of white rice',
    components: [
      { query: 'chicken breast meat only roasted', grams: 150 },
      { query: 'rice white long grain regular enriched cooked', grams: 160 },
    ],
  },
  {
    id: 'eggs-toast',
    text: 'two scrambled eggs and a slice of whole wheat toast',
    components: [
      { query: 'egg whole cooked scrambled', grams: 122 },
      { query: 'bread whole wheat commercially prepared toasted', grams: 26 },
    ],
  },
  {
    id: 'banana',
    text: 'a medium banana',
    components: [{ query: 'bananas raw', grams: 118 }],
  },
  {
    id: 'greek-yogurt',
    text: 'a cup of plain nonfat greek yogurt',
    components: [{ query: 'yogurt greek plain nonfat', grams: 245 }],
  },
  {
    id: 'pb-sandwich',
    text: 'a peanut butter sandwich: two slices of white bread with two tablespoons of peanut butter',
    components: [
      { query: 'bread white commercially prepared', grams: 54 },
      { query: 'peanut butter smooth style with salt', grams: 32 },
    ],
  },
  {
    id: 'milk-2pct',
    text: 'a glass of 2% milk, about 8 ounces',
    components: [{ query: 'milk reduced fat fluid 2', grams: 244 }],
  },
  {
    id: 'avocado-half',
    text: 'half an avocado',
    components: [{ query: 'avocados raw all commercial varieties', grams: 100 }],
  },
  {
    id: 'olive-oil',
    text: 'a tablespoon of olive oil',
    components: [{ query: 'oil olive salad or cooking', grams: 14 }],
  },
  {
    id: 'salmon',
    text: '100 grams of cooked atlantic salmon',
    components: [{ query: 'salmon atlantic farmed cooked dry heat', grams: 100 }],
  },
  {
    id: 'apple',
    text: 'a medium apple',
    components: [{ query: 'apples raw with skin', grams: 182 }],
  },
  {
    id: 'oatmeal-honey',
    text: 'a cup of cooked oatmeal with a tablespoon of honey',
    components: [
      { query: 'oats regular and quick cooked with water', grams: 234 },
      { query: 'honey', grams: 21 },
    ],
  },
  {
    id: 'burrito-decomposed',
    text: 'a burrito with a large flour tortilla, half a cup of white rice, half a cup of black beans, and 3 oz of grilled chicken breast',
    components: [
      { query: 'tortillas ready to bake or fry flour', grams: 70 },
      { query: 'rice white long grain regular enriched cooked', grams: 80 },
      { query: 'beans black mature seeds cooked boiled', grams: 86 },
      { query: 'chicken breast meat only roasted', grams: 85 },
    ],
  },
];

// Same normalization + ranking as the app's searchFoods (mobile/src/lib/foods.ts)
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query) {
  const all = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
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

const cases = SPECS.map((spec) => {
  const resolved = spec.components.map((c) => {
    const food = search(c.query);
    if (!food) throw new Error(`Case ${spec.id}: no DB match for "${c.query}"`);
    return { ...c, food };
  });
  const expected = resolved.reduce(
    (sum, { food, grams }) => ({
      kcal: sum.kcal + (food.kcal * grams) / 100,
      protein: sum.protein + ((food.protein ?? 0) * grams) / 100,
      carbs: sum.carbs + ((food.carbs ?? 0) * grams) / 100,
      fat: sum.fat + ((food.fat ?? 0) * grams) / 100,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  console.log(`${spec.id}: ${Math.round(expected.kcal)} kcal`);
  for (const r of resolved) console.log(`   ${r.grams} g  ${r.food.name}`);
  return {
    id: spec.id,
    text: spec.text,
    expected: {
      kcal: Math.round(expected.kcal * 10) / 10,
      protein: Math.round(expected.protein * 10) / 10,
      carbs: Math.round(expected.carbs * 10) / 10,
      fat: Math.round(expected.fat * 10) / 10,
    },
    n_items: spec.components.length,
    truth: resolved.map((r) => ({ name: r.food.name, grams: r.grams })),
  };
});

const out = join(HERE, 'cases.jsonl');
writeFileSync(out, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`\nWrote ${cases.length} cases to ${out}`);
