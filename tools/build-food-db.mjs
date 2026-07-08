// Builds mobile/assets/foods.db from USDA FoodData Central CSV dumps.
//
// Inputs (download + extract first, see tools/README.md):
//   tools/data/sr_legacy/FoodData_Central_sr_legacy_food_csv_2018-04/
//   tools/data/foundation/FoodData_Central_foundation_food_csv_2025-12-18/
//   tools/data/survey/FoodData_Central_survey_food_csv_2024-10-31/   (FNDDS)
//
// Output: mobile/assets/foods.db
//   foods(id, name, name_norm, category, data_type, kcal, protein, carbs,
//         fat, fiber, sugar, sodium_mg, sat_fat, cholesterol_mg, calcium_mg,
//         iron_mg, potassium_mg, portions_json)          -- nutrients per 100 g
//   meta(key, value)
//
// Usage: node tools/build-food-db.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SR_DIR = join(ROOT, 'data', 'sr_legacy', 'FoodData_Central_sr_legacy_food_csv_2018-04');
const FN_DIR = join(ROOT, 'data', 'foundation', 'FoodData_Central_foundation_food_csv_2025-12-18');
const SV_DIR = join(ROOT, 'data', 'survey', 'FoodData_Central_survey_food_csv_2024-10-31');
const OUT = join(ROOT, '..', 'mobile', 'assets', 'foods.db');

// ---------- CSV parsing (RFC 4180) ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadCsv(dir, name) {
  const rows = parseCsv(readFileSync(join(dir, name), 'utf8'));
  const header = rows.shift();
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return { rows, idx };
}

// ---------- Nutrient extraction ----------

// nutrient_id preference order per macro (first found wins). FDC ids first;
// the sub-1000 fallbacks are legacy nutrient *numbers*, which the FNDDS dump
// uses in its food_nutrient.csv instead of FDC ids (no collision — FDC ids
// start at 1001).
const NUTRIENTS = {
  kcal:           ['1008', '2047', '2048', '208'], // Energy, Atwater General, Atwater Specific
  protein:        ['1003', '203'],
  fat:            ['1004', '1085', '204'],         // Total lipid, Total fat (NLEA)
  carbs:          ['1005', '1050', '205'],         // By difference, by summation
  fiber:          ['1079', '2033', '291'],         // Total dietary, AOAC 2011.25
  sugar:          ['2000', '1063', '269'],         // Total sugars, Sugars NLEA
  sodium_mg:      ['1093', '307'],
  sat_fat:        ['1258', '606'],                 // Fatty acids, total saturated (g)
  cholesterol_mg: ['1253', '601'],                 // Cholesterol (mg)
  calcium_mg:     ['1087', '301'],                 // Calcium, Ca (mg)
  iron_mg:        ['1089', '303'],                 // Iron, Fe (mg)
  potassium_mg:   ['1092', '306'],                 // Potassium, K (mg)
};

function extractNutrients(dir) {
  const { rows, idx } = loadCsv(dir, 'food_nutrient.csv');
  const byFood = new Map(); // fdc_id -> { nutrient_id -> amount }
  for (const r of rows) {
    const fdcId = r[idx.fdc_id];
    const nutId = r[idx.nutrient_id];
    const amount = r[idx.amount];
    if (amount === '') continue;
    let m = byFood.get(fdcId);
    if (!m) { m = {}; byFood.set(fdcId, m); }
    // keep first occurrence; duplicates are rare and equivalent
    if (!(nutId in m)) m[nutId] = parseFloat(amount);
  }
  const result = new Map(); // fdc_id -> {kcal, protein, ...}
  for (const [fdcId, m] of byFood) {
    const out = {};
    for (const [key, ids] of Object.entries(NUTRIENTS)) {
      out[key] = null;
      for (const id of ids) {
        if (id in m) { out[key] = m[id]; break; }
      }
    }
    // derive kcal from macros if missing (4/4/9 Atwater)
    if (out.kcal == null && out.protein != null && out.carbs != null && out.fat != null) {
      out.kcal = Math.round(out.protein * 4 + out.carbs * 4 + out.fat * 9);
    }
    result.set(fdcId, out);
  }
  return result;
}

// ---------- Portions ----------

function extractPortions(dir, style = 'standard') {
  const units = new Map(
    loadCsv(dir, 'measure_unit.csv').rows.map((r) => [r[0], r[1]])
  );
  const { rows, idx } = loadCsv(dir, 'food_portion.csv');
  const byFood = new Map(); // fdc_id -> [{label, grams}]
  for (const r of rows) {
    const grams = parseFloat(r[idx.gram_weight]);
    if (!grams || grams <= 0) continue;
    let label;
    if (style === 'survey') {
      // FNDDS: the human-readable measure is portion_description ("1 cup");
      // modifier is an internal numeric code, and measure_unit is undetermined.
      label = (r[idx.portion_description] || '').trim();
      if (!label || /^quantity not specified$/i.test(label)) continue;
    } else {
      const amount = r[idx.amount] ? parseFloat(r[idx.amount]) : null;
      const unitName = units.get(r[idx.measure_unit_id]);
      const unit = unitName && unitName !== 'undetermined' ? unitName : '';
      const modifier = (r[idx.modifier] || '').trim();
      const desc = (r[idx.portion_description] || '').trim();
      label = [amount != null && amount !== 0 ? trimNum(amount) : '', unit, modifier || desc]
        .filter(Boolean).join(' ').trim();
    }
    if (!label) continue;
    let list = byFood.get(r[idx.fdc_id]);
    if (!list) { list = []; byFood.set(r[idx.fdc_id], list); }
    if (list.length < 6) list.push({ label, grams });
  }
  return byFood;
}

function trimNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ---------- Foods ----------

// Apostrophes are dropped (not split) so "McDONALD'S" matches a search for
// "mcdonalds". MUST stay in sync with normName in mobile/src/lib/foods.ts.
function normName(s) {
  return s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractFoods(dir, wantedDataType, dataTypeLabel, style = 'standard') {
  // FNDDS categorizes via WWEIA (food_category_id holds the WWEIA number);
  // SR/Foundation use the shared food_category table.
  const categories = new Map(
    style === 'survey'
      ? loadCsv(dir, 'wweia_food_category.csv').rows.map((r) => [r[0], r[1]])
      : loadCsv(dir, 'food_category.csv').rows.map((r) => [r[0], r[2]])
  );
  const { rows, idx } = loadCsv(dir, 'food.csv');
  const nutrients = extractNutrients(dir);
  const portions = extractPortions(dir, style);
  const foods = [];
  for (const r of rows) {
    if (r[idx.data_type] !== wantedDataType) continue;
    const fdcId = r[idx.fdc_id];
    const n = nutrients.get(fdcId);
    if (!n || n.kcal == null) continue; // unusable without energy
    // Strip USDA boilerplate — pure noise that skews length-based ranking
    const name = r[idx.description]
      .replace(/\s*\(Includes foods for USDA's Food Distribution Program\)/i, '')
      .trim();
    foods.push({
      id: parseInt(fdcId, 10),
      name,
      name_norm: normName(name),
      category: categories.get(r[idx.food_category_id]) ?? null,
      data_type: dataTypeLabel,
      ...n,
      portions_json: JSON.stringify(portions.get(fdcId) ?? []),
    });
  }
  return foods;
}

// ---------- Main ----------

console.log('Loading SR Legacy...');
const srFoods = extractFoods(SR_DIR, 'sr_legacy_food', 'sr_legacy');
console.log(`  ${srFoods.length} foods`);

console.log('Loading Foundation...');
const fnFoods = extractFoods(FN_DIR, 'foundation_food', 'foundation');
console.log(`  ${fnFoods.length} foods`);

console.log('Loading FNDDS survey foods...');
const svFoods = extractFoods(SV_DIR, 'survey_fndds_food', 'survey', 'survey');
console.log(`  ${svFoods.length} foods`);

// Dedup by exact normalized name: Foundation (newest analysis) wins over SR;
// both win over FNDDS (survey values are recipe-derived, not lab-analyzed).
const fnNames = new Set(fnFoods.map((f) => f.name_norm));
const merged = [...fnFoods, ...srFoods.filter((f) => !fnNames.has(f.name_norm))];
const seenNames = new Set(merged.map((f) => f.name_norm));
merged.push(...svFoods.filter((f) => !seenNames.has(f.name_norm)));
console.log(`Merged: ${merged.length} foods (${srFoods.length + fnFoods.length + svFoods.length - merged.length} duplicates dropped)`);

// ---------- Common flag (manual-search subset) ----------
// The full merge stays in the DB: the on-device model's search terms — and the
// SFT/eval pipeline's gold labels — resolve against ALL of it, for best
// coverage. But manual typing in the app searches only foods flagged
// `common = 1`: a clean consumer subset so "rice" isn't buried under 300 real
// matches. That subset is FNDDS "what people eat" (clean names like "Banana,
// raw", "Chicken breast"), minus its "skin eaten / NS as to cooking method"
// survey artifacts, plus SR's branded fast-food/restaurant items.
const dedup = new Set();
const core = merged.filter((f) => {
  if (dedup.has(f.name_norm)) return false; // drop exact duplicate rows
  dedup.add(f.name_norm);
  return true;
});

// `common` is a manual-search priority tier:
//   2 = primary generic — a single food, further specified with comma
//       qualifiers ("Rice, white, cooked", "Banana, raw", "Chicken, ..., breast,
//       ... roasted"). These rank first when a person types a food.
//   1 = other everyday foods — compound/prepared items people eat (FNDDS dishes,
//       "Rice milk", branded fast food).
//   0 = reference-only — not shown for manual typing (the AI resolver still uses
//       it). Baby foods and FNDDS as-eaten survey artifacts land here.
const NOISE = /\bskin( \/ coating)?( not)? eaten\b|\bcoating( not)? eaten\b|\bns as to\b/i;
const SR_BRAND_CATS = new Set(['Fast Foods', 'Restaurant Foods']);
const QUALIFIER =
  /^(raw|cooked|boiled|baked|roasted|grilled|fried|steamed|dried|fresh|frozen|canned|whole|skim|nonfat|lowfat|low fat|reduced fat|2%|1%|nfs|ns|plain|unsalted|salted|sweetened|unsweetened|with|without|meat|skin|light|dark|regular|prepared|enriched|white|brown|red|green|ripe|large|medium|small|extra|part|solids|drained|instant|from|includes|commercially|smooth|creamy|chunky|ground|sliced|shredded|crumbled|fluid|powder|mix)\b/i;
const isPrimaryGeneric = (name) => {
  const comma = name.indexOf(',');
  if (comma < 0) return false; // no qualifiers → compound noun, not a generic
  const head = name.slice(0, comma).trim();
  if (head.split(/\s+/).length > 3) return false; // long head = a specific dish
  if (/fast ?foods?|restaurant/i.test(head) || /[A-Z]{3,}/.test(head)) return false; // brand/category head, not a food ("Fast Foods, Fried Chicken...")
  const after = name.slice(comma + 1).trim();
  return QUALIFIER.test(after); // "Rice, WHITE" yes; "Rice, a la ..." no
};
// Clean SR/Foundation lean cuts ("Chicken, ..., breast, meat only, cooked,
// roasted") — the canonical cooked meats people track, which FNDDS only carries
// as "skin eaten / not eaten" noise. Promote them into the manual subset.
const LEAN_CUT = /\bmeat only\b/i;
const COOKED = /\b(cooked|roasted|braised|grilled|broiled|stewed|baked)\b/i;
for (const f of core) {
  const babyOrNoise =
    f.category === 'Baby Foods' || /^babyfood/i.test(f.name) || (f.data_type === 'survey' && NOISE.test(f.name));
  f.common = babyOrNoise
    ? 0
    : isPrimaryGeneric(f.name)
      ? 2
      : f.data_type === 'survey' || SR_BRAND_CATS.has(f.category)
        ? 1
        : LEAN_CUT.test(f.name) && COOKED.test(f.name)
          ? 1
          : 0;
}
const tally = (t) => core.filter((f) => f.common === t).length;
console.log(`Foods: ${core.length} total | common tiers — primary ${tally(2)}, everyday ${tally(1)}, reference-only ${tally(0)}`);

mkdirSync(dirname(OUT), { recursive: true });
if (existsSync(OUT)) rmSync(OUT);
const db = new DatabaseSync(OUT);
db.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA page_size = 4096;
  CREATE TABLE foods (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_norm TEXT NOT NULL,
    category TEXT,
    data_type TEXT NOT NULL,
    kcal REAL NOT NULL,
    protein REAL,
    carbs REAL,
    fat REAL,
    fiber REAL,
    sugar REAL,
    sodium_mg REAL,
    sat_fat REAL,
    cholesterol_mg REAL,
    calcium_mg REAL,
    iron_mg REAL,
    potassium_mg REAL,
    common INTEGER NOT NULL DEFAULT 0,
    portions_json TEXT NOT NULL
  );
  CREATE INDEX idx_foods_name_norm ON foods(name_norm);
  CREATE INDEX idx_foods_common ON foods(common);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

const insert = db.prepare(`
  INSERT INTO foods (id, name, name_norm, category, data_type, kcal, protein,
                     carbs, fat, fiber, sugar, sodium_mg, sat_fat,
                     cholesterol_mg, calcium_mg, iron_mg, potassium_mg,
                     common, portions_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
db.exec('BEGIN');
for (const f of core) {
  insert.run(f.id, f.name, f.name_norm, f.category, f.data_type, f.kcal,
    f.protein, f.carbs, f.fat, f.fiber, f.sugar, f.sodium_mg, f.sat_fat,
    f.cholesterol_mg, f.calcium_mg, f.iron_mg, f.potassium_mg, f.common, f.portions_json);
}
db.exec('COMMIT');

const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
setMeta.run('schema_version', '3');
setMeta.run('food_count', String(core.length));
setMeta.run('sources', 'USDA FDC SR Legacy 2018-04; Foundation 2025-12-18; FNDDS 2021-2023');
setMeta.run('built_at', new Date().toISOString());

db.exec('VACUUM');
db.close();

console.log(`Wrote ${OUT}`);
