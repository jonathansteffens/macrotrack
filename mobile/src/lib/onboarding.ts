import { getUserDb } from './db';

/** First-launch onboarding: shown once, tracked by a settings flag. */

export async function isOnboardingDone(): Promise<boolean> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'onboarding_done'"
  );
  return row?.value === '1';
}

export async function markOnboardingDone(): Promise<void> {
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_done', '1')"
  );
}
