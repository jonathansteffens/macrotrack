import type { FoodClaim } from './types';

/**
 * Shared result type and claim sanitizer for the on-device estimator
 * (mobile/src/lib/ai/local.ts). The app is local-only — there is no cloud
 * engine — so the only failure that isn't a plain message is "the model isn't
 * downloaded yet" (needsModel).
 */

export type EstimateResult =
  | { ok: true; claim: FoodClaim }
  | { ok: false; message: string; needsModel?: boolean };

/** Enforce the bounds the schema can't express (clamped in code, not grammar). */
export function sanitizeClaim(claim: FoodClaim): FoodClaim {
  return {
    ...claim,
    items: claim.items
      .filter((i) => i.grams > 0)
      .map((i) => ({
        ...i,
        grams: Math.min(i.grams, 5000),
        confidence: Math.max(0, Math.min(1, i.confidence)),
      })),
    questions: claim.questions.slice(0, 2),
    needs_clarification: claim.needs_clarification && claim.questions.length > 0,
  };
}
