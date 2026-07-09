// Shared overlay logic for mobile/assets/foods.db, applied both:
//   (a) standalone, by tools/db/merge-fastfood.mjs against the shipped DB, and
//   (b) as the final stage of tools/build-food-db.mjs, so a full rebuild from
//       the raw USDA CSVs doesn't silently drop the curated branded rows /
//       display names that build-food-db.mjs itself has no way to derive.
// Keeping the logic here (imported by both) means there is exactly one
// implementation to keep correct, instead of two copies that can drift.
//
// All three operations are idempotent: applying them twice in a row leaves
// the DB in the same state as applying them once (branded rows are cleared
// and re-inserted fresh each time; the chain reclassification's UPDATE only
// matches data_type='survey' rows, so a second pass matches zero additional
// rows; display_name UPDATEs just re-set the same values).

import { existsSync, readFileSync } from 'node:fs';

// MUST match normName in build-food-db.mjs / mobile/src/lib/foods.ts (and
// mobile/src/lib/norm.ts) -- apostrophes dropped (not split) so "McDONALD'S"
// matches a search for "mcdonalds".
export function normName(s) {
  return s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Reads + JSON-parses `path`, or returns null with a console note if it's
 *  absent -- both overlay inputs are optional so a DB can still be built
 *  (just without the overlay) when they haven't been generated/curated yet. */
export function loadJsonIfExists(path, label) {
  if (!existsSync(path)) {
    console.log(`[overlays] ${label} not found at ${path} -- skipping this overlay`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Inserts curated branded rows (tools/db-data/fastfood-curated.json shape)
 *  into `db`'s foods table as data_type='branded'. Idempotent: clears any
 *  existing branded rows first, then re-inserts with fresh ids -- so re-running
 *  never accumulates duplicates. Skips an item whose normalized name already
 *  exists in the table (avoids clobbering a generic entry's search hits). */
export function applyFastfoodOverlay(db, items) {
  if (!items || items.length === 0) return { before: 0, inserted: 0, skipped: 0 };
  const before = db.prepare("SELECT COUNT(*) c FROM foods WHERE data_type='branded'").get().c;
  db.exec("DELETE FROM foods WHERE data_type='branded'"); // idempotent
  let nextId = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM foods').get().n;
  const existing = new Set(db.prepare('SELECT name_norm FROM foods').all().map((r) => r.name_norm));

  const ins = db.prepare(`INSERT INTO foods
    (id, name, name_norm, category, data_type, kcal, protein, carbs, fat, fiber, sugar,
     sodium_mg, sat_fat, cholesterol_mg, calcium_mg, iron_mg, potassium_mg, common, portions_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let inserted = 0;
  let skipped = 0;
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
  return { before, inserted, skipped };
}

// FNDDS survey rows for chain items ("Whopper (Burger King)", "Quarter Pounder
// (McDonalds)") are authoritative whole-item data with real serving portions --
// reclassify them as 'branded' so the resolver's serving-snap applies to them
// too (they often win the shortest-name search over the MenuStat rows above).
export const CHAIN_PAREN = ['McDonalds', "Wendy's", 'Burger King', 'Taco Bell', 'Pizza Hut',
  "Domino's", 'Subway', 'KFC', 'Popeyes', 'Chick-fil-A', 'Little Caesars',
  "Papa John's", 'Burger King)', 'Starbucks', 'Dunkin'];

export function applyChainReclassification(db) {
  const like = CHAIN_PAREN.map(() => 'name LIKE ?').join(' OR ');
  const upd = db.prepare(`UPDATE foods SET data_type='branded'
    WHERE data_type='survey' AND (${like})`);
  const res = upd.run(...CHAIN_PAREN.map((c) => `%(${c}%`));
  return { changed: res.changes };
}

/** Applies a canonical-name -> display-name map (tools/db-data/display-names.json
 *  shape) to `db`. Adds the display_name column if the table doesn't have it
 *  yet (fresh builds never do). */
export function applyDisplayNames(db, names) {
  if (!names || Object.keys(names).length === 0) return { applied: 0 };
  const cols = db.prepare('PRAGMA table_info(foods)').all().map((c) => c.name);
  if (!cols.includes('display_name')) db.exec('ALTER TABLE foods ADD COLUMN display_name TEXT');
  // display_name_norm: normalized common-language index — lets search match the
  // words users actually type ("mac and cheese") alongside canonical name_norm.
  if (!cols.includes('display_name_norm')) db.exec('ALTER TABLE foods ADD COLUMN display_name_norm TEXT');
  const upd = db.prepare('UPDATE foods SET display_name = ?, display_name_norm = ? WHERE name = ?');
  let applied = 0;
  db.exec('BEGIN');
  for (const [canonical, display] of Object.entries(names)) {
    upd.run(display, normName(display), canonical);
    applied++;
  }
  db.exec('COMMIT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_foods_display_name_norm ON foods(display_name_norm)');
  return { applied };
}

// Curated common-tier promotions: everyday staples the source data leaves at
// common=0, so manual search can't surface them (found empirically — "chicken"
// had no plain cooked-chicken generic in the curated tier). Exact-name matches;
// silently skipped when a row is absent.
export const COMMON_PROMOTIONS = [
  'Chicken breast, rotisserie, skin not eaten',
  'Chicken breast, grilled without sauce, skin not eaten',
  'Chicken breast, roasted, skin not eaten',
];
export function applyCommonPromotions(db) {
  const upd = db.prepare('UPDATE foods SET common = 2 WHERE name = ? AND common < 2');
  let promoted = 0;
  for (const name of COMMON_PROMOTIONS) promoted += upd.run(name).changes;
  return { promoted };
}
