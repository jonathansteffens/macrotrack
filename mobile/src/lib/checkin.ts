import { Platform } from 'react-native';

import { logicalDayKey } from './dates';
import { getUserDb } from './db';

/**
 * Optional daily "evening check-in": a single, kind local notification that
 * only fires on days where nothing has been logged yet. Off by default.
 *
 * Scheduling strategy: instead of one repeating daily trigger (whose next
 * occurrence can't be selectively skipped), the next 7 evenings get one-shot
 * DATE triggers, re-synced on every app open and after every log. An evening
 * whose logical day already has entries is simply not scheduled. Deliberate
 * side effect: if the app goes untouched for a week the reminders run out —
 * quiet retention, not nagging.
 */

const HOUR_KEY = 'checkin_hour';
const CHANNEL_ID = 'checkin';
const HORIZON_DAYS = 7;

/** Selectable check-in hours (chips in settings; 8 PM is the suggested pick). */
export const CHECKIN_HOURS = [18, 19, 20, 21, 22] as const;

export function checkinLabel(hour: number): string {
  return `${hour - 12} PM`;
}

/** expo-notifications is iOS/Android only — no web support in SDK 57. */
export function checkinSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

// Loaded lazily so the module never touches the web bundle's critical path
// (same pattern as llama.rn in ai/local-model.ts).
function notifications() {
  return import('expo-notifications');
}

/** The configured check-in hour, or null when the check-in is off (default). */
export async function getCheckinHour(): Promise<number | null> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'checkin_hour'"
  );
  const hour = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(hour) && hour > 0 ? hour : null;
}

/** Persist the hour (null = off) and re-sync the scheduled notifications. */
export async function setCheckinHour(hour: number | null): Promise<void> {
  await getUserDb().runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('${HOUR_KEY}', ?)`,
    hour == null ? '-1' : String(hour)
  );
  await syncCheckinNotification();
}

/** True when the check-in is on but the OS permission is (or became) denied. */
export async function checkinPermissionMissing(): Promise<boolean> {
  if (!checkinSupported()) return false;
  if ((await getCheckinHour()) == null) return false;
  const N = await notifications();
  return !(await N.getPermissionsAsync()).granted;
}

/** Ask for notification permission if we still can. Returns granted-now. */
export async function requestCheckinPermission(): Promise<boolean> {
  if (!checkinSupported()) return false;
  const N = await notifications();
  const current = await N.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await N.requestPermissionsAsync()).granted;
}

/**
 * Reconcile the OS schedule with reality: cancel everything (the check-in is
 * the app's only notification) and schedule the evenings that still deserve
 * one. Called on app start, whenever Today regains focus, and on setting
 * changes — cheap enough to run fire-and-forget.
 */
export async function syncCheckinNotification(): Promise<void> {
  if (!checkinSupported()) return;
  const N = await notifications();
  await N.cancelAllScheduledNotificationsAsync();

  const hour = await getCheckinHour();
  if (hour == null) return;
  if (!(await N.getPermissionsAsync()).granted) return;

  if (Platform.OS === 'android') {
    // Android 8+ requires a channel; created idempotently before scheduling.
    await N.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Evening check-in',
      importance: N.AndroidImportance.DEFAULT,
    });
  }

  // Days (logical, day-end aware) that already have entries don't get a nudge.
  const now = new Date();
  const dayRows = await getUserDb().getAllAsync<{ day: string }>(
    'SELECT DISTINCT day FROM log_entries WHERE day >= ?',
    logicalDayKey(now)
  );
  const loggedDays = new Set(dayRows.map((r) => r.day));

  for (let i = 0; i < HORIZON_DAYS; i++) {
    const fireAt = new Date(now);
    fireAt.setDate(fireAt.getDate() + i);
    fireAt.setHours(hour, 0, 0, 0);
    if (fireAt <= now) continue; // this evening already passed
    if (loggedDays.has(logicalDayKey(fireAt))) continue; // already logged — stay quiet
    await N.scheduleNotificationAsync({
      content: {
        title: 'Evening check-in',
        body: 'Feel like logging today’s meals? It only takes a minute — no pressure.',
        sound: false,
      },
      trigger: {
        type: N.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        channelId: CHANNEL_ID,
      },
    });
  }
}
