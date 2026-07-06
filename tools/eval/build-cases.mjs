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
  // ---- Expanded set (Phase 3): held out of ALL training data. ----
  // Gram weights come from each food's USDA household portions (portions_json).
  {
    id: 'turkey-sandwich',
    text: 'a turkey sandwich: two slices of whole wheat bread, 3 oz of deli turkey breast, a slice of swiss cheese, and a tablespoon of mayo',
    components: [
      { query: 'bread whole wheat commercially prepared', grams: 64 },
      { query: 'turkey breast deli', grams: 85 },
      { query: 'cheese swiss', grams: 28 },
      { query: 'salad dressing mayonnaise regular', grams: 14 },
    ],
  },
  {
    id: 'steak-potato',
    text: 'an 8 oz grilled sirloin steak with a medium baked potato and a tablespoon of butter',
    components: [
      { query: 'beef top sirloin steak cooked broiled', grams: 227 },
      { query: 'potatoes baked flesh and skin', grams: 173 },
      { query: 'butter salted', grams: 14 },
    ],
  },
  {
    id: 'shrimp-pasta',
    text: '150 g of cooked shrimp over a cup and a half of cooked pasta with a tablespoon of olive oil',
    components: [
      { query: 'crustaceans shrimp cooked moist heat', grams: 150 },
      { query: 'pasta cooked enriched without added salt', grams: 210 },
      { query: 'oil olive salad or cooking', grams: 14 },
    ],
  },
  {
    id: 'tilapia-broccoli',
    text: '6 oz of baked tilapia with a cup of steamed broccoli',
    components: [
      { query: 'fish tilapia cooked dry heat', grams: 170 },
      { query: 'broccoli cooked boiled drained without salt', grams: 156 },
    ],
  },
  {
    id: 'turkey-rice-bowl',
    text: '4 oz of cooked ground turkey over a cup of brown rice',
    components: [
      { query: 'turkey ground cooked', grams: 113 },
      { query: 'rice brown long grain cooked', grams: 195 },
    ],
  },
  {
    id: 'pancakes-syrup',
    text: 'three frozen pancakes with two tablespoons of maple syrup',
    components: [
      { query: 'pancakes plain frozen ready to heat', grams: 123 },
      { query: 'syrups maple', grams: 40 },
    ],
  },
  {
    id: 'bagel-cream-cheese',
    text: 'a plain bagel (about 100 g) with two tablespoons of cream cheese',
    components: [
      { query: 'bagels plain enriched', grams: 99 },
      { query: 'cheese cream', grams: 29 },
    ],
  },
  {
    id: 'cereal-milk',
    text: 'a cup of corn flakes with a cup of 2% milk',
    components: [
      { query: 'cereals corn flakes', grams: 28 },
      { query: 'milk reduced fat fluid 2', grams: 244 },
    ],
  },
  {
    id: 'french-toast',
    text: 'two slices of french toast with a tablespoon of maple syrup',
    components: [
      { query: 'french toast prepared recipe', grams: 130 },
      { query: 'syrups maple', grams: 20 },
    ],
  },
  {
    id: 'granola-yogurt',
    text: 'half a cup of granola with a cup of plain nonfat greek yogurt',
    components: [
      { query: 'granola homemade', grams: 61 },
      { query: 'yogurt greek plain nonfat', grams: 245 },
    ],
  },
  {
    id: 'cheeseburger',
    text: 'a homemade cheeseburger: a plain hamburger bun, a quarter-pound beef patty (about 85 g cooked), and a slice of american cheese',
    components: [
      { query: 'rolls hamburger plain', grams: 44 },
      { query: 'beef ground 80 patty cooked broiled', grams: 85 },
      { query: 'cheese american', grams: 21 },
    ],
  },
  {
    id: 'fries-medium',
    text: 'a medium order of french fries, about 115 g',
    components: [{ query: 'fast foods potato french fried', grams: 115 }],
  },
  {
    id: 'cheese-pizza',
    text: 'two slices of frozen cheese pizza, about 107 g per slice',
    components: [{ query: 'pizza cheese regular crust frozen cooked', grams: 214 }],
  },
  {
    id: 'beef-tacos',
    text: 'two hard shell beef tacos from a fast food place, about 100 g each',
    components: [{ query: 'taco beef hard shell', grams: 200 }],
  },
  {
    id: 'hot-dog',
    text: 'a beef hot dog on a plain bun',
    components: [
      { query: 'frankfurter beef', grams: 48 },
      { query: 'rolls hamburger plain', grams: 44 },
    ],
  },
  {
    id: 'orange-juice',
    text: 'a cup of orange juice',
    components: [{ query: 'orange juice raw', grams: 248 }],
  },
  {
    id: 'cola-can',
    text: 'a 12 oz can of regular cola',
    components: [{ query: 'beverages carbonated cola regular', grams: 368 }],
  },
  {
    id: 'beer-can',
    text: 'a 12 oz can of regular beer',
    components: [{ query: 'beer regular all', grams: 356 }],
  },
  {
    id: 'ice-cream-bowl',
    text: 'a cup of vanilla ice cream',
    components: [{ query: 'ice creams vanilla', grams: 132 }],
  },
  {
    id: 'cookies',
    text: 'two soft chocolate chip cookies, about 15 g each',
    components: [{ query: 'cookies chocolate chip commercially prepared', grams: 30 }],
  },
  {
    id: 'chips',
    text: 'an ounce of plain salted potato chips',
    components: [{ query: 'snacks potato chips plain salted', grams: 28 }],
  },
  {
    id: 'popcorn',
    text: 'three cups of air-popped popcorn',
    components: [{ query: 'popcorn air popped', grams: 24 }],
  },
  {
    id: 'dark-chocolate',
    text: '20 g of dark chocolate, 70-85% cacao',
    components: [{ query: 'chocolate dark 70 85', grams: 20 }],
  },
  {
    id: 'hummus-carrots',
    text: '100 g of baby carrots dipped in a quarter cup of hummus',
    components: [
      { query: 'carrots raw', grams: 100 },
      { query: 'hummus commercial', grams: 62 },
    ],
  },
  {
    id: 'chicken-stir-fry',
    text: 'chicken stir fry: 150 g of chicken breast, a cup of mixed vegetables, a tablespoon of canola oil, and a cup of white rice',
    components: [
      { query: 'chicken breast meat only roasted', grams: 150 },
      { query: 'vegetables mixed frozen cooked boiled', grams: 182 },
      { query: 'oil canola', grams: 14 },
      { query: 'rice white long grain regular enriched cooked', grams: 160 },
    ],
  },
  {
    id: 'spaghetti-beef',
    text: 'two cups of cooked spaghetti with half a cup of marinara sauce and 100 g of cooked ground beef',
    components: [
      { query: 'pasta cooked enriched without added salt', grams: 280 },
      { query: 'sauce marinara ready serve', grams: 128 },
      { query: 'beef ground 85 patty cooked broiled', grams: 100 },
    ],
  },
  {
    id: 'chicken-caesar-salad',
    text: 'a chicken caesar salad: two cups of chopped romaine, 100 g of grilled chicken breast, two tablespoons of caesar dressing, and 10 g of grated parmesan',
    components: [
      { query: 'lettuce cos or romaine raw', grams: 94 },
      { query: 'chicken breast meat only roasted', grams: 100 },
      { query: 'salad dressing caesar regular', grams: 30 },
      { query: 'cheese parmesan grated', grams: 10 },
    ],
  },
  {
    id: 'pbj-sandwich',
    text: 'a PB&J: two slices of white bread, two tablespoons of peanut butter, and a tablespoon of jam',
    components: [
      { query: 'bread white commercially prepared', grams: 54 },
      { query: 'peanut butter smooth style with salt', grams: 32 },
      { query: 'jams preserves', grams: 20 },
    ],
  },
  {
    id: 'quesadilla',
    text: 'a cheese quesadilla: one large flour tortilla with 60 g of shredded cheddar',
    components: [
      { query: 'tortillas ready to bake or fry flour', grams: 70 },
      { query: 'cheese cheddar', grams: 60 },
    ],
  },
  {
    id: 'omelet-cheese',
    text: 'a three-egg omelet with 30 g of cheddar cheese',
    components: [
      { query: 'egg whole cooked omelet', grams: 183 },
      { query: 'cheese cheddar', grams: 30 },
    ],
  },
  {
    id: 'grapes',
    text: 'a cup of red grapes',
    components: [{ query: 'grapes european type raw', grams: 151 }],
  },
  {
    id: 'watermelon',
    text: 'two cups of diced watermelon',
    components: [{ query: 'watermelon raw', grams: 304 }],
  },
  {
    id: 'sweet-potato',
    text: 'a medium baked sweet potato',
    components: [{ query: 'sweet potato cooked baked skin', grams: 114 }],
  },
  {
    id: 'corn-butter',
    text: 'kernels from one medium ear of corn (about 90 g) with a teaspoon of butter',
    components: [
      { query: 'corn sweet yellow cooked boiled', grams: 90 },
      { query: 'butter salted', grams: 5 },
    ],
  },
  {
    id: 'edamame',
    text: 'a cup of shelled edamame',
    components: [{ query: 'edamame frozen prepared', grams: 155 }],
  },
  {
    id: 'almond-butter-toast',
    text: 'two slices of whole wheat toast with a tablespoon of almond butter',
    components: [
      { query: 'bread whole wheat commercially prepared toasted', grams: 52 },
      { query: 'nuts almond butter plain', grams: 16 },
    ],
  },
  {
    id: 'cottage-blueberries',
    text: 'a cup of cottage cheese with half a cup of blueberries',
    components: [
      { query: 'cheese cottage lowfat 2 milkfat', grams: 226 },
      { query: 'blueberries raw', grams: 74 },
    ],
  },
  {
    id: 'rice-beans-oil',
    text: 'a cup of white rice, a cup of black beans, and a tablespoon of olive oil',
    components: [
      { query: 'rice white long grain regular enriched cooked', grams: 160 },
      { query: 'beans black mature seeds cooked boiled', grams: 172 },
      { query: 'oil olive salad or cooking', grams: 14 },
    ],
  },
  {
    id: 'protein-shake',
    text: 'a protein shake: one 30 g scoop of whey protein powder mixed with a cup of 2% milk',
    components: [
      { query: 'beverages protein powder whey', grams: 30 },
      { query: 'milk reduced fat fluid 2', grams: 244 },
    ],
  },
  {
    id: 'chicken-thighs-quinoa',
    text: 'two roasted chicken thighs (about 150 g total, no skin) with a cup of cooked quinoa',
    components: [
      { query: 'chicken thigh meat only roasted', grams: 150 },
      { query: 'quinoa cooked', grams: 185 },
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
