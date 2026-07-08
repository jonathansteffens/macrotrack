// Builds mobile/assets/foods.db from USDA FoodData Central CSV dumps.
//
// Inputs (download + extract first, see tools/README.md):
//   tools/data/sr_legacy/FoodData_Central_sr_legacy_food_csv_2018-04/
//   tools/data/foundation/FoodData_Central_foundation_food_csv_2025-12-18/
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

// nutrient_id preference order per macro (first found wins)
const NUTRIENTS = {
  kcal:           ['1008', '2047', '2048'], // Energy, Atwater General, Atwater Specific
  protein:        ['1003'],
  fat:            ['1004', '1085'],         // Total lipid, Total fat (NLEA)
  carbs:          ['1005', '1050'],         // By difference, by summation
  fiber:          ['1079', '2033'],         // Total dietary, AOAC 2011.25
  sugar:          ['2000', '1063'],         // Total sugars, Sugars NLEA
  sodium_mg:      ['1093'],
  sat_fat:        ['1258'],                 // Fatty acids, total saturated (g)
  cholesterol_mg: ['1253'],                 // Cholesterol (mg)
  calcium_mg:     ['1087'],                 // Calcium, Ca (mg)
  iron_mg:        ['1089'],                 // Iron, Fe (mg)
  potassium_mg:   ['1092'],                 // Potassium, K (mg)
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

function extractPortions(dir) {
  const units = new Map(
    loadCsv(dir, 'measure_unit.csv').rows.map((r) => [r[0], r[1]])
  );
  const { rows, idx } = loadCsv(dir, 'food_portion.csv');
  const byFood = new Map(); // fdc_id -> [{label, grams}]
  for (const r of rows) {
    const grams = parseFloat(r[idx.gram_weight]);
    if (!grams || grams <= 0) continue;
    const amount = r[idx.amount] ? parseFloat(r[idx.amount]) : null;
    const unitName = units.get(r[idx.measure_unit_id]);
    const unit = unitName && unitName !== 'undetermined' ? unitName : '';
    const modifier = (r[idx.modifier] || '').trim();
    const desc = (r[idx.portion_description] || '').trim();
    let label = [amount != null && amount !== 0 ? trimNum(amount) : '', unit, modifier || desc]
      .filter(Boolean).join(' ').trim();
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

function normName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractFoods(dir, wantedDataType, dataTypeLabel) {
  const categories = new Map(
    loadCsv(dir, 'food_category.csv').rows.map((r) => [r[0], r[2]])
  );
  const { rows, idx } = loadCsv(dir, 'food.csv');
  const nutrients = extractNutrients(dir);
  const portions = extractPortions(dir);
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

// Dedup: exact normalized-name matches prefer Foundation (newer analysis)
const fnNames = new Set(fnFoods.map((f) => f.name_norm));
const merged = [...fnFoods, ...srFoods.filter((f) => !fnNames.has(f.name_norm))];
console.log(`Merged: ${merged.length} foods (${srFoods.length + fnFoods.length - merged.length} SR duplicates dropped)`);

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
    portions_json TEXT NOT NULL
  );
  CREATE INDEX idx_foods_name_norm ON foods(name_norm);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

const insert = db.prepare(`
  INSERT INTO foods (id, name, name_norm, category, data_type, kcal, protein,
                     carbs, fat, fiber, sugar, sodium_mg, sat_fat,
                     cholesterol_mg, calcium_mg, iron_mg, potassium_mg,
                     portions_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
db.exec('BEGIN');
for (const f of merged) {
  insert.run(f.id, f.name, f.name_norm, f.category, f.data_type, f.kcal,
    f.protein, f.carbs, f.fat, f.fiber, f.sugar, f.sodium_mg, f.sat_fat,
    f.cholesterol_mg, f.calcium_mg, f.iron_mg, f.potassium_mg, f.portions_json);
}
db.exec('COMMIT');

const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
setMeta.run('schema_version', '2');
setMeta.run('food_count', String(merged.length));
setMeta.run('sources', 'USDA FDC SR Legacy 2018-04; Foundation 2025-12-18');
setMeta.run('built_at', new Date().toISOString());

db.exec('VACUUM');
db.close();

console.log(`Wrote ${OUT}`);
