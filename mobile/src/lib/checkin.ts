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

const HOUR_KEY = 'checkin_hour'; // legacy whole-hour setting, read-only now
const TIME_KEY = 'checkin_time'; // 'H:MM' 24h, or '-1' for off
const CHANNEL_ID = 'checkin';
const HORIZON_DAYS = 7;

export type CheckinTime = { hour: number; minute: number };

/** "8:30 PM" — the normalized display form. */
export function formatCheckinTime(t: CheckinTime): string {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}:${String(t.minute).padStart(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}`;
}

/** Lenient parse: "8pm", "8:30 PM", "20:30" all work; null = unintelligible. */
export function parseCheckinTime(text: string): CheckinTime | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\.?\s*$/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (minute > 59) return null;
  const mer = m[3]?.toLowerCase();
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (mer.startsWith('p')) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

/** expo-notifications is iOS/Android only — no web support in SDK 57. */
export function checkinSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

// Loaded lazily so the module never touches the web bundle's critical path
// (same pattern as llama.rn in ai/local-model.ts). Returns null when the
// native module isn't in this runtime — Expo Go, or a dev build made before
// expo-notifications was added — so a missing build never crashes the app;
// the check-in feature just stays unavailable until the app is rebuilt.
type NotificationsModule = typeof import('expo-notifications');
async function notifications(): Promise<NotificationsModule | null> {
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

/** The configured check-in time, or null when the check-in is off (default).
 *  Falls back to the legacy whole-hour setting from the old chip UI. */
export async function getCheckinTime(): Promise<CheckinTime | null> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = '${TIME_KEY}'`
  );
  if (row) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(row.value);
    return m ? { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) } : null;
  }
  const legacy = await getUserDb().getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = '${HOUR_KEY}'`
  );
  const hour = legacy ? parseInt(legacy.value, 10) : NaN;
  return Number.isFinite(hour) && hour > 0 ? { hour, minute: 0 } : null;
}

/** Persist the time (null = off) and re-sync the scheduled notifications. */
export async function setCheckinTime(t: CheckinTime | null): Promise<void> {
  await getUserDb().runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('${TIME_KEY}', ?)`,
    t == null ? '-1' : `${t.hour}:${String(t.minute).padStart(2, '0')}`
  );
  await syncCheckinNotification();
}

/** True when the check-in is on but the OS permission is (or became) denied. */
export async function checkinPermissionMissing(): Promise<boolean> {
  if (!checkinSupported()) return false;
  if ((await getCheckinTime()) == null) return false;
  const N = await notifications();
  if (!N) return false;
  return !(await N.getPermissionsAsync()).granted;
}

/** Ask for notification permission if we still can. Returns granted-now. */
export async function requestCheckinPermission(): Promise<boolean> {
  if (!checkinSupported()) return false;
  const N = await notifications();
  if (!N) return false;
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
  if (!N) return;
  await N.cancelAllScheduledNotificationsAsync();

  const time = await getCheckinTime();
  if (time == null) return;
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
    fireAt.setHours(time.hour, time.minute, 0, 0);
    if (fireAt <= now) continue; // this evening already passed
    if (loggedDays.has(logicalDayKey(fireAt))) continue; // already logged — stay quiet
    await N.scheduleNotificationAsync({
      content: {
        title: 'Evening check-in',
        body: 'Log today’s meals?',
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
