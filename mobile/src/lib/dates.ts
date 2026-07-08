/**
 * Local-timezone day keys (YYYY-MM-DD). All log bucketing uses these.
 *
 * Days are "logical" days: they run from the user's day-end hour to the next
 * day's day-end hour rather than midnight to midnight, so a 12:30am snack
 * counts toward the evening it belongs to. The hour is a setting (see
 * day-end.ts); it's cached here so the synchronous call sites don't each
 * have to read the database.
 */

export const DEFAULT_DAY_END_HOUR = 3;

let cachedDayEndHour = DEFAULT_DAY_END_HOUR;

/** Set by day-end.ts on app start and whenever the setting changes. */
export function setDayEndHourCache(hour: number): void {
  cachedDayEndHour = hour;
}

/** Plain calendar date of a Date, ignoring the day-end hour. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The logical day a timestamp belongs to: times before `dayEndHour` count
 * toward the previous calendar day.
 */
export function logicalDayKey(date: Date, dayEndHour = cachedDayEndHour): string {
  return dayKey(new Date(date.getTime() - dayEndHour * 60 * 60 * 1000));
}

export function todayKey(): string {
  return logicalDayKey(new Date());
}

export function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, n: number): string {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** "Today", "Yesterday", or e.g. "Tue, Jun 30" */
export function dayLabel(key: string): string {
  const today = todayKey();
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  if (key === addDays(today, 1)) return 'Tomorrow';
  return keyToDate(key).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** Short label for chart axes, e.g. "6/30" */
export function shortLabel(key: string): string {
  const d = keyToDate(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** The last `n` day keys ending at today, oldest first. */
export function lastNDays(n: number): string[] {
  const today = todayKey();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}
