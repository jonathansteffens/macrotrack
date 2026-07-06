import { getUserDb } from '../db';
import { cloudEstimate, type EstimateResult } from './estimator';
import { localEstimate } from './local';
import type { EstimateTurn } from './types';

/**
 * Engine dispatch — the Phase 3 architecture, live today with Haiku standing
 * in for the on-device model:
 *   cloud — one large-model call (Opus by default)
 *   local — the small-model pipeline (Haiku stand-in; later on-device)
 *   auto  — local first, transparent cloud fallback on error or low confidence
 */

export type EngineMode = 'cloud' | 'local' | 'auto';

export const ENGINE_MODES: { id: EngineMode; label: string }[] = [
  { id: 'cloud', label: 'Cloud' },
  { id: 'local', label: 'Local stand-in' },
  { id: 'auto', label: 'Auto' },
];

/** Below this mean confidence, auto mode escalates to the cloud engine. */
const AUTO_FALLBACK_CONFIDENCE = 0.45;

export type EngineResult = EstimateResult & {
  engine?: 'cloud' | 'local';
  fellBack?: boolean;
};

export async function getEngineMode(): Promise<EngineMode> {
  const row = await getUserDb().getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'ai_engine'"
  );
  return (row?.value as EngineMode) ?? 'cloud';
}

export async function setEngineMode(mode: EngineMode): Promise<void> {
  await getUserDb().runAsync(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_engine', ?)",
    mode
  );
}

export async function estimateWithEngine(turns: EstimateTurn[]): Promise<EngineResult> {
  const mode = await getEngineMode();

  if (mode === 'cloud') {
    return { ...(await cloudEstimate(turns)), engine: 'cloud' };
  }

  const local = await localEstimate(turns);
  if (mode === 'local') {
    return { ...local, engine: 'local' };
  }

  // auto: accept a confident local result, otherwise escalate
  if (local.ok && local.claim.items.length > 0 && meanConfidence(local) >= AUTO_FALLBACK_CONFIDENCE) {
    return { ...local, engine: 'local' };
  }
  if (!local.ok && local.needsKey) {
    return { ...local, engine: 'local' }; // no key — cloud would fail identically
  }
  return { ...(await cloudEstimate(turns)), engine: 'cloud', fellBack: true };
}

function meanConfidence(result: EstimateResult): number {
  if (!result.ok || result.claim.items.length === 0) return 0;
  return (
    result.claim.items.reduce((s, i) => s + i.confidence, 0) / result.claim.items.length
  );
}
