import * as SQLite from 'expo-sqlite';

import { normName } from './norm';

/**
 * Two databases:
 *  - foods.db  — read-only bundled USDA data, copied from assets on first
 *                launch. Safe to overwrite on app updates (bump FOODS_DB_VERSION
 *                when assets/foods.db is rebuilt).
 *  - user.db   — everything the user creates: log entries, custom foods,
 *                barcode cache, settings. Never overwritten.
 */

const FOODS_DB_VERSION = 6;

let foodsDb: SQLite.SQLiteDatabase | null = null;
let userDb: SQLite.SQLiteDatabase | null = null;

const USER_SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS custom_foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  brand TEXT,
  kcal REAL NOT NULL,
  protein REAL NOT NULL DEFAULT 0,
  carbs REAL NOT NULL DEFAULT 0,
  fat REAL NOT NULL DEFAULT 0,
  fiber REAL,
  sugar REAL,
  sodium_mg REAL,
  sat_fat REAL,
  cholesterol_mg REAL,
  calcium_mg REAL,
  iron_mg REAL,
  potassium_mg REAL,
  portions_json TEXT NOT NULL DEFAULT '[]',
  barcode TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS barcode_cache (
  barcode TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  kcal REAL NOT NULL,
  protein REAL NOT NULL DEFAULT 0,
  carbs REAL NOT NULL DEFAULT 0,
  fat REAL NOT NULL DEFAULT 0,
  fiber REAL,
  sugar REAL,
  sodium_mg REAL,
  sat_fat REAL,
  cholesterol_mg REAL,
  calcium_mg REAL,
  iron_mg REAL,
  potassium_mg REAL,
  portions_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  ts TEXT NOT NULL,
  meal TEXT NOT NULL,
  food_name TEXT NOT NULL,
  food_ref TEXT,
  quantity_desc TEXT NOT NULL,
  grams REAL,
  kcal REAL NOT NULL,
  protein REAL NOT NULL,
  carbs REAL NOT NULL,
  fat REAL NOT NULL,
  fiber REAL,
  sugar REAL,
  sodium_mg REAL,
  sat_fat REAL,
  cholesterol_mg REAL,
  calcium_mg REAL,
  iron_mg REAL,
  potassium_mg REAL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_day ON log_entries(day);
CREATE INDEX IF NOT EXISTS idx_log_ref ON log_entries(food_ref);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  servings REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  food_name TEXT NOT NULL,
  food_ref TEXT,
  grams REAL NOT NULL,
  per100_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipe_items ON recipe_items(recipe_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weights (
  day TEXT PRIMARY KEY,
  weight REAL NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meal_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  input_text TEXT,
  had_image INTEGER NOT NULL DEFAULT 0,
  turns_json TEXT NOT NULL,
  logged_json TEXT
);
`;

export async function initDb(): Promise<void> {
  if (foodsDb && userDb) return;

  userDb = await SQLite.openDatabaseAsync('user.db');
  await userDb.execAsync(USER_SCHEMA);

  // Additive column migrations for existing installs. ALTER throws if the
  // column already exists; we ignore that (it just means the migration ran).
  const nutrientCols = ['sat_fat', 'cholesterol_mg', 'calcium_mg', 'iron_mg', 'potassium_mg'];
  const migrations = [
    "ALTER TABLE barcode_cache ADD COLUMN unit TEXT NOT NULL DEFAULT 'g'",
    "ALTER TABLE custom_foods ADD COLUMN unit TEXT NOT NULL DEFAULT 'g'",
    "ALTER TABLE log_entries ADD COLUMN unit TEXT NOT NULL DEFAULT 'g'",
    // Extra nutrients added later — nullable, so existing rows read as "unknown".
    ...['barcode_cache', 'custom_foods', 'log_entries'].flatMap((t) =>
      nutrientCols.map((c) => `ALTER TABLE ${t} ADD COLUMN ${c} REAL`)
    ),
  ];
  for (const stmt of migrations) {
    await userDb.execAsync(stmt).catch(() => {});
  }

  // Re-normalize custom food names if the normalization rules changed (e.g.
  // apostrophe handling). Cheap: custom foods number in the dozens at most.
  const customRows = await userDb.getAllAsync<{ id: number; name: string; name_norm: string }>(
    'SELECT id, name, name_norm FROM custom_foods'
  );
  for (const r of customRows) {
    const norm = normName(r.name);
    if (norm !== r.name_norm) {
      await userDb.runAsync('UPDATE custom_foods SET name_norm = ? WHERE id = ?', norm, r.id);
    }
  }

  // Re-import the bundled food DB when the app ships a newer build of it.
  const row = await userDb.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'foods_db_version'"
  );
  const haveVersion = row ? parseInt(row.value, 10) : 0;
  await SQLite.importDatabaseFromAssetAsync('foods.db', {
    assetId: require('../../assets/foods.db'),
    forceOverwrite: haveVersion !== FOODS_DB_VERSION,
  });
  await userDb.runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('foods_db_version', ?)",
    String(FOODS_DB_VERSION)
  );

  foodsDb = await SQLite.openDatabaseAsync('foods.db');
}

export function getFoodsDb(): SQLite.SQLiteDatabase {
  if (!foodsDb) throw new Error('DB not initialized — call initDb() first');
  return foodsDb;
}

export function getUserDb(): SQLite.SQLiteDatabase {
  if (!userDb) throw new Error('DB not initialized — call initDb() first');
  return userDb;
}
