/** Local-timezone day keys (YYYY-MM-DD). All log bucketing uses these. */

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayKey(): string {
  return dayKey(new Date());
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
