// Merge the curated MenuStat branded items (tools/db-data/fastfood-curated.json)
// into foods.db as data_type='branded' rows, and reclassify the FNDDS chain-item
// survey rows alongside them. Idempotent: clears prior branded rows first, then
// re-inserts with fresh ids. name_norm matches build-food-db.mjs so the app's
// search (and the model's db_search_terms) resolve them.
//
//   node tools/db/merge-fastfood.mjs [--db mobile/assets/foods.db] [--src tools/db-data/fastfood-curated.json]
//
// The actual insert/reclassify logic lives in tools/db/overlays.mjs, shared
// with the overlay stage at the end of tools/build-food-db.mjs, so a full
// rebuild from raw USDA CSVs re-applies the same curated overlay instead of
// silently losing it. This script remains a standalone way to (re-)apply the
// overlay to an already-built DB without rerunning the full build.
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFastfoodOverlay, applyChainReclassification, loadJsonIfExists } from './overlays.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const DB_PATH = arg('db', join(ROOT, 'mobile', 'assets', 'foods.db'));
const SRC = arg('src', join(ROOT, 'tools', 'db-data', 'fastfood-curated.json'));

const items = loadJsonIfExists(SRC, 'fastfood-curated.json') ?? [];
const db = new DatabaseSync(DB_PATH);

const { before, inserted, skipped } = applyFastfoodOverlay(db, items);
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

const { changed } = applyChainReclassification(db);
console.log(`reclassified ${changed} survey chain rows as branded (serving-snap applies)`);
