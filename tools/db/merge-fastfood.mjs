// Merge the curated MenuStat branded items (tools/db-data/fastfood-curated.json)
// into foods.db as data_type='branded' rows. Idempotent: clears prior branded
// rows first, then re-inserts with fresh ids. name_norm matches build-food-db.mjs
// so the app's search (and the model's db_search_terms) resolve them.
//
//   node tools/db/merge-fastfood.mjs [--db mobile/assets/foods.db]
//
// NOTE: foods.db is a build artifact of build-food-db.mjs; for full
// reproducibility that builder should also fold in fastfood-curated.json. This
// script applies the merge to the shipped DB directly for the current cycle.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const DB_PATH = arg('db', join(ROOT, 'mobile', 'assets', 'foods.db'));
const SRC = arg('src', join(ROOT, 'tools', 'db-data', 'fastfood-curated.json'));

// MUST match normName in build-food-db.mjs / mobile/src/lib/foods.ts
const normName = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const items = JSON.parse(readFileSync(SRC, 'utf8'));
const db = new DatabaseSync(DB_PATH);

const before = db.prepare("SELECT COUNT(*) c FROM foods WHERE data_type='branded'").get().c;
db.exec("DELETE FROM foods WHERE data_type='branded'");           // idempotent
let nextId = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM foods').get().n;

// Skip a branded item whose normalized name already exists (avoid clobbering a
// generic entry's search hits with a duplicate key).
const existing = new Set(db.prepare('SELECT name_norm FROM foods').all().map((r) => r.name_norm));

const ins = db.prepare(`INSERT INTO foods
  (id, name, name_norm, category, data_type, kcal, protein, carbs, fat, fiber, sugar,
   sodium_mg, sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg, common, portions_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let inserted = 0, skipped = 0;
db.exec('BEGIN');
for (const it of items) {
  const nn = normName(it.name);
  if (existing.has(nn)) { skipped++; continue; }
  existing.add(nn);
  ins.run(nextId++, it.name, nn, it.category ?? null, 'branded',
    it.kcal, it.protein, it.carbs, it.fat, it.fiber, it.sugar,
    it.sodium_mg, it.sat_fat, it.cholesterol_mg, it.calcium_mg, it.iron_mg, it.potassium_mg,
    1 /* common: everyday tier */, JSON.stringify(it.portions ?? []));
  inserted++;
}
db.exec('COMMIT');

const total = db.prepare('SELECT COUNT(*) c FROM foods').get().c;
console.log(`branded rows: ${before} → ${inserted} (${skipped} skipped as dup name_norm)`);
console.log(`foods.db total rows: ${total}`);
// sanity: a few resolve like the app would
for (const q of ['mcdonalds big mac', 'wendys baconator', 'taco bell crunchy taco', 'chipotle chicken burrito bowl']) {
  const toks = q.split(' ');
  const where = toks.map(() => "(' ' || name_norm) LIKE ?").join(' AND ');
  const row = db.prepare(`SELECT name, kcal FROM foods WHERE ${where} ORDER BY LENGTH(name_norm) LIMIT 1`).get(...toks.map((t) => `% ${t}%`));
  console.log(`  "${q}" -> ${row ? row.name + ' (' + Math.round(row.kcal) + '/100g)' : 'NO MATCH'}`);
}

// FNDDS survey rows for chain items ("Whopper (Burger King)", "Quarter Pounder
// (McDonalds)") are authoritative whole-item data with real serving portions —
// reclassify them as 'branded' so the resolver's serving-snap applies to them
// too (they often win the shortest-name search over our MenuStat rows).
const CHAIN_PAREN = ['McDonalds', "Wendy's", 'Burger King', 'Taco Bell', 'Pizza Hut',
  "Domino's", 'Subway', 'KFC', 'Popeyes', 'Chick-fil-A', 'Little Caesars',
  "Papa John's", 'Burger King)', 'Starbucks', 'Dunkin'];
const like = CHAIN_PAREN.map(() => `name LIKE ?`).join(' OR ');
const upd2 = db.prepare(`UPDATE foods SET data_type='branded'
  WHERE data_type='survey' AND (${like})`);
const res2 = upd2.run(...CHAIN_PAREN.map((c) => `%(${c}%`));
console.log(`reclassified ${res2.changes} survey chain rows as branded (serving-snap applies)`);
