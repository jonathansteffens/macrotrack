import { FOOD_CLAIM_SCHEMA } from './schema';

/**
 * Web stub for the on-device model manager. llama.rn is a native module with
 * no web build, so on web the local engine is simply unavailable — the app's
 * auto mode falls back to cloud, and the Settings UI shows "not available
 * here". Metro resolves this file for web in place of local-model.ts, keeping
 * llama.rn out of the web bundle entirely.
 */

export const LOCAL_MODEL_TOTAL_BYTES = 1_929_900_928 + 1_338_428_032;

export type LocalModelStatus = 'ready' | 'missing' | 'unsupported';

export class LocalModelUnavailable extends Error {
  constructor(readonly reason: 'unsupported' | 'missing' = 'unsupported') {
    super('On-device model not supported here');
  }
}

export function isLocalModelSupported(): boolean {
  return false;
}

export async function getLocalModelStatus(): Promise<LocalModelStatus> {
  return 'unsupported';
}

export async function downloadLocalModel(_onProgress?: (fraction: number) => void): Promise<void> {
  throw new LocalModelUnavailable('unsupported');
}

export async function deleteLocalModel(): Promise<void> {
  // nothing downloaded on web
}

export function runOnLocalContext<T>(_fn: (ctx: never) => Promise<T>): Promise<T> {
  return Promise.reject(new LocalModelUnavailable('unsupported'));
}

export async function releaseLocalContext(): Promise<void> {
  // no context on web
}

export const CLAIM_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'food_claim', strict: true, schema: FOOD_CLAIM_SCHEMA },
} as const;
