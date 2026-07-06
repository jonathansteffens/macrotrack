// Validates app runtime logic that can't run under Node directly:
//  1. the exact search SQL used in mobile/src/lib/foods.ts (LIKE ESCAPE + ranking)
//  2. Open Food Facts API response shape assumed by mobile/src/lib/off.ts
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('mobile/assets/foods.db', { readOnly: true });

// --- 1. Search SQL (mirrors searchFoods) ---
function normName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function likePattern(token) {
  return '%' + token.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query, limit = 5) {
  const all = normName(query).split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  const prefix = `${tokens[0]}%`;
  const orderBy = `CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm)`;
  return db
    .prepare(`SELECT name, kcal FROM foods WHERE ${where} ORDER BY ${orderBy} LIMIT ?`)
    .all(...params, prefix, limit);
}

for (const q of ['chicken breast', 'egg', 'greek yogurt', 'rice cooked', '100% weird_chars%']) {
  const t0 = performance.now();
  const rows = search(q);
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`"${q}" (${ms} ms):`);
  for (const r of rows) console.log(`   ${r.name} — ${Math.round(r.kcal)} kcal`);
}

// --- 2. OFF API shape (mirrors lookupBarcode) ---
const OFF_FIELDS =
  'product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit';
const resp = await fetch(
  `https://world.openfoodfacts.org/api/v2/product/3017624010701.json?fields=${OFF_FIELDS}`,
  { headers: { 'User-Agent': 'MacroTrack/0.1 (personal macro tracker)' } }
);
const json = await resp.json();
const p = json.product;
const n = p.nutriments;
console.log('\nOFF Nutella (3017624010701):');
console.log('  status:', json.status, '| name:', p.product_name, '| brand:', p.brands);
console.log(
  '  per100g: kcal', n['energy-kcal_100g'],
  '| P', n['proteins_100g'],
  '| C', n['carbohydrates_100g'],
  '| F', n['fat_100g'],
  '| sugar', n['sugars_100g'],
  '| salt', n['salt_100g'],
  '| sodium', n['sodium_100g']
);
console.log('  serving:', p.serving_size, '| qty:', p.serving_quantity, p.serving_quantity_unit);

// Unknown barcode should 404 or return status 0
const miss = await fetch('https://world.openfoodfacts.org/api/v2/product/0000000000017.json', {
  headers: { 'User-Agent': 'MacroTrack/0.1 (personal macro tracker)' },
});
console.log('\nUnknown barcode → HTTP', miss.status);
