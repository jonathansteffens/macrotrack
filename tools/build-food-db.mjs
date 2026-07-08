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

// ---------- Consumer-core filter ----------
// The raw merge is an exhaustive reference set; trim it to what a person would
// actually log so search isn't buried in near-duplicates. SR + Foundation stay
// (the model + the SFT/eval pipeline resolve gold labels against their names).
// From FNDDS we keep only prepared/mixed *dishes* (burrito bowl, latte, pad
// thai) — its single-food entries just duplicate SR with different wording, and
// its "skin eaten / not eaten / NS as to cooking method" variants are survey
// artifacts. Baby foods and exact name duplicates go too.
const DISH_WORDS =
  /\b(sandwich|sub|burrito|taco|tostada|pizza|calzone|stromboli|soup|chowder|bisque|salad|slaw|stew|chili|casserole|burger|cheeseburger|wrap|bowl|nachos|quesadilla|enchilada|tamale|fajita|lasagna|ravioli|gnocchi|spaghetti|macaroni|curry|stir[- ]?fry|fried rice|lo mein|pad thai|ramen|pho|sushi|dumpling|potsticker|pot pie|parmesan|alfredo|gumbo|jambalaya|risotto|paella|omelet|frittata|quiche|scramble|benedict|hash|smoothie|shake|latte|frappe|frappuccino|cappuccino|macchiato|mocha|americano|parfait|platter|combo|nuggets|tenders|tots|fries)\b/i;
const JOIN_WORDS = /\b(and|with|over|topped)\b/i;
const NOISE = /\bskin( \/ coating)?( not)? eaten\b|\bcoating( not)? eaten\b|\bns as to\b/i;
const isDish = (name) => {
  const head = name.split(',')[0];
  return DISH_WORDS.test(name) || JOIN_WORDS.test(name) || /[A-Z]{3,}/.test(head); // brand caps
};

const coreSeen = new Set();
const core = merged.filter((f) => {
  if (coreSeen.has(f.name_norm)) return false; // exact duplicate row
  if (f.category === 'Baby Foods' || /^babyfood/i.test(f.name)) return false;
  if (f.data_type === 'survey') {
    if (NOISE.test(f.name)) return false; // as-eaten survey artifacts
    if (!isDish(f.name)) return false; // single food already covered by SR
  }
  coreSeen.add(f.name_norm);
  return true;
});
console.log(`Consumer core: ${core.length} foods (${merged.length - core.length} trimmed)`);

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
for (const f of core) {
  insert.run(f.id, f.name, f.name_norm, f.category, f.data_type, f.kcal,
    f.protein, f.carbs, f.fat, f.fiber, f.sugar, f.sodium_mg, f.sat_fat,
    f.cholesterol_mg, f.calcium_mg, f.iron_mg, f.potassium_mg, f.portions_json);
}
db.exec('COMMIT');

const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
setMeta.run('schema_version', '2');
setMeta.run('food_count', String(core.length));
setMeta.run('sources', 'USDA FDC SR Legacy 2018-04; Foundation 2025-12-18; FNDDS 2021-2023');
setMeta.run('built_at', new Date().toISOString());

db.exec('VACUUM');
db.close();

console.log(`Wrote ${OUT}`);
