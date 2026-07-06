import * as SecureStore from 'expo-secure-store';

import { getUserDb } from '../db';

/**
 * The Anthropic API key lives in the device keychain (SecureStore), never in
 * the SQLite database. Model choice is an ordinary setting.
 */

const KEY_NAME = 'anthropic_api_key';

export const AI_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (best)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast + cheap)' },
] as const;

export const DEFAULT_AI_MODEL = 'claude-opus-4-8';

export async function getApiKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_NAME);
  } catch {
    return null;
  }
}

export async function setApiKey(key: string): Promise<void> {
  if (key.trim()) {
    await SecureStore.setItemAsync(KEY_NAME, key.trim());
  } else {
    await SecureStore.deleteItemAsync(KEY_NAME);
  }
}

export async function getAiModel(): Promise<string> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'ai_model'"
  );
  return row?.value ?? DEFAULT_AI_MODEL;
}

export async function setAiModel(model: string): Promise<void> {
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_model', ?)",
    model
  );
}
