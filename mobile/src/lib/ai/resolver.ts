import { searchFoods } from '../foods';
import { scaleMacros } from '../macros';
import type { FoodItem, Macros } from '../types';
import type { ClaimItem, FoodClaim } from './types';

/**
 * The resolver is where AI claims meet the food database: each claimed item
 * is matched against bundled USDA + custom foods so final nutrition numbers
 * come from canonical data. The model's own per-100g estimate is used only
 * when nothing matches (flagged as `ai_estimate` on the log entry).
 */

export type ResolvedItem = {
  claim: ClaimItem;
  /** Chosen DB match; null → fall back to the model's estimate */
  match: FoodItem | null;
  /** Other candidates the user can switch to */
  alternatives: FoodItem[];
  /** Editable amount, seeded from the claim */
  grams: number;
};

export async function resolveClaim(claim: FoodClaim): Promise<ResolvedItem[]> {
  return Promise.all(claim.items.map(resolveItem));
}

async function resolveItem(item: ClaimItem): Promise<ResolvedItem> {
  const terms = [...item.db_search_terms, item.name];
  let candidates: FoodItem[] = [];
  for (const term of terms) {
    candidates = await searchFoods(term, 6);
    if (candidates.length > 0) break;
  }
  return {
    claim: item,
    match: candidates[0] ?? null,
    alternatives: candidates.slice(0, 5),
    grams: Math.round(item.grams),
  };
}

/** Macros for the item as currently resolved (DB match or model fallback). */
export function resolvedMacros(item: ResolvedItem): Macros {
  if (item.match) return scaleMacros(item.match.per100, item.grams);
  const f = item.grams / 100;
  return {
    kcal: item.claim.est_per100.kcal * f,
    protein: item.claim.est_per100.protein * f,
    carbs: item.claim.est_per100.carbs * f,
    fat: item.claim.est_per100.fat * f,
    fiber: null,
    sugar: null,
    sodiumMg: null,
  };
}

export function displayName(item: ResolvedItem): string {
  return item.match ? item.match.name : item.claim.name;
}
