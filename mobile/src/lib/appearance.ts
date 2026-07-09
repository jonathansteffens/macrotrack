import { getUserDb } from './db';

/**
 * Manual appearance override. 'system' follows the OS light/dark setting;
 * 'light' / 'dark' pin the app regardless of the OS. Persisted under the
 * 'appearance' settings key and mirrored into a module-level store so every
 * `useColorScheme()` consumer re-renders the instant it changes (and reads the
 * saved value on the next launch). Default is 'system'.
 *
 * This is an external store read via useSyncExternalStore in the color-scheme
 * hooks — the same shape as dates.ts's day-end cache.
 */

export type AppearancePref = 'system' | 'light' | 'dark';

export const APPEARANCE_OPTIONS: AppearancePref[] = ['system', 'light', 'dark'];

const APPEARANCE_LABELS: Record<AppearancePref, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function appearanceLabel(pref: AppearancePref): string {
  return APPEARANCE_LABELS[pref];
}

let pref: AppearancePref = 'system';
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to override changes (for useSyncExternalStore). */
export function subscribeAppearance(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current override (for useSyncExternalStore's getSnapshot). */
export function getAppearance(): AppearancePref {
  return pref;
}

/** Load the persisted override into the store. Called once after initDb(). */
export async function loadAppearance(): Promise<void> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'appearance'"
  );
  pref = row?.value === 'light' || row?.value === 'dark' ? row.value : 'system';
  emit();
}

/** Persist and apply an override immediately (all consumers re-render). */
export async function setAppearance(next: AppearancePref): Promise<void> {
  pref = next;
  emit();
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('appearance', ?)",
    next
  );
}
