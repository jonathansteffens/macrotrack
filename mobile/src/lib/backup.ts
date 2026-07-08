import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { dayKey } from './dates';
import { loadDayEndHour } from './day-end';
import { getUserDb } from './db';

/**
 * Full backup & restore of everything the user has created, as one JSON file
 * in a versioned envelope. The bundled foods.db is deliberately not included
 * — it ships with the app. Restore replaces the current data wholesale inside
 * a single transaction, so a bad file can't leave things half-restored.
 */

export const BACKUP_VERSION = 1;

/** Every user-generated table in user.db. Row ids are exported as-is so
 *  food_ref pointers ('custom:<id>') and recipe_items.recipe_id stay wired. */
const USER_TABLES = [
  'custom_foods',
  'barcode_cache',
  'log_entries',
  'recipes',
  'recipe_items',
  'weights',
  'meal_templates',
  'ai_events',
  'settings',
] as const;

type UserTable = (typeof USER_TABLES)[number];
type Row = Record<string, string | number | null>;

export type Backup = {
  app: 'macrotrack';
  backupVersion: number;
  exportedAt: string;
  data: Record<UserTable, Row[]>;
};

/** Describes this install, not the user's data — never exported or restored. */
const INSTALL_SETTINGS = new Set(['foods_db_version']);

async function collectBackup(): Promise<Backup> {
  const db = getUserDb();
  const data = {} as Backup['data'];
  for (const table of USER_TABLES) {
    const rows = await db.getAllAsync<Row>(`SELECT * FROM ${table} ORDER BY rowid`);
    data[table] =
      table === 'settings' ? rows.filter((r) => !INSTALL_SETTINGS.has(String(r.key))) : rows;
  }
  return {
    app: 'macrotrack',
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Build the backup file and hand it to the OS share sheet. */
export async function exportBackup(): Promise<void> {
  const backup = await collectBackup();
  const file = new File(Paths.cache, `macrotrack-backup-${dayKey(new Date())}.json`);
  if (file.exists) file.delete();
  file.create();
  file.write(JSON.stringify(backup));
  await Sharing.shareAsync(file.uri, {
    dialogTitle: 'MacroTrack backup',
    mimeType: 'application/json',
    UTI: 'public.json',
  });
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_backup_at', ?)",
    new Date().toISOString()
  );
}

export async function getLastBackupAt(): Promise<string | null> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'last_backup_at'"
  );
  return row?.value ?? null;
}

/**
 * Parse and validate backup JSON. Throws with a user-readable message; on
 * success every cell is a plain string/number/null and every column name is a
 * safe identifier, so rows can be re-inserted directly.
 */
export function parseBackup(json: string): Backup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const b = parsed as Partial<Backup> | null;
  if (b?.app !== 'macrotrack' || typeof b.backupVersion !== 'number' || b.data == null) {
    throw new Error('That file is not a MacroTrack backup.');
  }
  if (b.backupVersion > BACKUP_VERSION) {
    throw new Error(
      `This backup was made by a newer version of the app (v${b.backupVersion}) — update MacroTrack first.`
    );
  }
  const data = {} as Backup['data'];
  for (const table of USER_TABLES) {
    const rows = (b.data as Record<string, unknown>)[table] ?? [];
    if (!Array.isArray(rows)) throw new Error(`Backup is corrupted (bad ${table}).`);
    for (const row of rows) {
      if (typeof row !== 'object' || row == null || Array.isArray(row)) {
        throw new Error(`Backup is corrupted (bad ${table} row).`);
      }
      for (const [col, value] of Object.entries(row)) {
        const okCol = /^[A-Za-z_][A-Za-z0-9_]*$/.test(col);
        const okVal = value === null || typeof value === 'string' || typeof value === 'number';
        if (!okCol || !okVal) throw new Error(`Backup is corrupted (bad ${table} row).`);
      }
    }
    data[table] = rows as Row[];
  }
  return {
    app: 'macrotrack',
    backupVersion: b.backupVersion,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
    data,
  };
}

/**
 * Replace all user data with the backup's contents — all tables wiped and
 * refilled in one exclusive transaction (rolled back entirely on any error).
 */
export async function restoreBackup(backup: Backup): Promise<void> {
  const db = getUserDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const table of USER_TABLES) {
      if (table === 'settings') {
        await txn.runAsync("DELETE FROM settings WHERE key != 'foods_db_version'");
      } else {
        await txn.runAsync(`DELETE FROM ${table}`);
      }
      for (const row of backup.data[table]) {
        if (table === 'settings' && INSTALL_SETTINGS.has(String(row.key))) continue;
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        await txn.runAsync(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => row[c])
        );
      }
    }
  });
  // The restored settings may carry a different day-end hour — refresh the cache.
  await loadDayEndHour();
}
