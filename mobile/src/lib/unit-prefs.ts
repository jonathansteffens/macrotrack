/**
 * Display-unit preferences: a unit system plus per-class overrides.
 *
 * Same shape as appearance.ts — persisted in the settings table and mirrored
 * into a module-level external store read via useSyncExternalStore, so every
 * screen showing an amount re-renders the instant the setting changes.
 *
 * These are DISPLAY preferences only. Stored grams never change, so switching
 * units can never alter a logged entry's macros — it only changes how the same
 * amount is written. See units.ts.
 */

import { getUserDb } from './db';
import { DEFAULT_UNIT_PREFS, type FoodClass, type UnitChoice, type UnitPrefs, type UnitSystem } from './units';

const SYSTEM_KEY = 'unit_system';
const OVERRIDES_KEY = 'unit_overrides';

let prefs: UnitPrefs = DEFAULT_UNIT_PREFS;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to preference changes (for useSyncExternalStore). */
export function subscribeUnitPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current preferences (for useSyncExternalStore's getSnapshot). */
export function getUnitPrefs(): UnitPrefs {
  return prefs;
}

const isSystem = (v: unknown): v is UnitSystem => v === 'us' || v === 'metric';

/** Load persisted preferences into the store. Called once after initDb(). */
export async function loadUnitPrefs(): Promise<void> {
  const db = getUserDb();
  const sys = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?', SYSTEM_KEY
  );
  const ov = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?', OVERRIDES_KEY
  );
  let overrides: UnitPrefs['overrides'] = {};
  if (ov?.value) {
    // A corrupt or hand-edited value must not break every amount in the app.
    try {
      const parsed: unknown = JSON.parse(ov.value);
      if (parsed && typeof parsed === 'object') overrides = parsed as UnitPrefs['overrides'];
    } catch {
      overrides = {};
    }
  }
  prefs = {
    system: isSystem(sys?.value) ? sys.value : DEFAULT_UNIT_PREFS.system,
    overrides,
  };
  emit();
}

/** Persist and apply a unit system immediately. */
export async function setUnitSystem(next: UnitSystem): Promise<void> {
  prefs = { ...prefs, system: next };
  emit();
  await getUserDb().runAsync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', SYSTEM_KEY, next
  );
}

/** Persist and apply a per-class override ('auto' clears it). */
export async function setUnitOverride(cls: FoodClass, choice: UnitChoice): Promise<void> {
  const overrides = { ...prefs.overrides };
  if (choice === 'auto') delete overrides[cls];
  else overrides[cls] = choice;
  prefs = { ...prefs, overrides };
  emit();
  await getUserDb().runAsync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', OVERRIDES_KEY, JSON.stringify(overrides)
  );
}
