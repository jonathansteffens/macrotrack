import { getUserDb } from './db';
import { DEFAULT_GOALS, type Goals } from './types';

export async function getGoals(): Promise<Goals> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'goals'"
  );
  if (!row) return DEFAULT_GOALS;
  try {
    return { ...DEFAULT_GOALS, ...JSON.parse(row.value) };
  } catch {
    return DEFAULT_GOALS;
  }
}

export async function setGoals(goals: Goals): Promise<void> {
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('goals', ?)",
    JSON.stringify(goals)
  );
}
