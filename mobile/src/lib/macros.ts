import type { Macros } from './types';

export const ZERO_MACROS: Macros = {
  kcal: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  fiber: 0,
  sugar: 0,
  sodiumMg: 0,
};

/** Scale per-100g values to a gram amount. */
export function scaleMacros(per100: Macros, grams: number): Macros {
  const f = grams / 100;
  return {
    kcal: per100.kcal * f,
    protein: per100.protein * f,
    carbs: per100.carbs * f,
    fat: per100.fat * f,
    fiber: per100.fiber != null ? per100.fiber * f : null,
    sugar: per100.sugar != null ? per100.sugar * f : null,
    sodiumMg: per100.sodiumMg != null ? per100.sodiumMg * f : null,
  };
}

/** Scale entry macros proportionally (used when editing quantity). */
export function rescaleMacros(macros: Macros, factor: number): Macros {
  return {
    kcal: macros.kcal * factor,
    protein: macros.protein * factor,
    carbs: macros.carbs * factor,
    fat: macros.fat * factor,
    fiber: macros.fiber != null ? macros.fiber * factor : null,
    sugar: macros.sugar != null ? macros.sugar * factor : null,
    sodiumMg: macros.sodiumMg != null ? macros.sodiumMg * factor : null,
  };
}

export function addMacros(a: Macros, b: Macros): Macros {
  return {
    kcal: a.kcal + b.kcal,
    protein: a.protein + b.protein,
    carbs: a.carbs + b.carbs,
    fat: a.fat + b.fat,
    fiber: (a.fiber ?? 0) + (b.fiber ?? 0),
    sugar: (a.sugar ?? 0) + (b.sugar ?? 0),
    sodiumMg: (a.sodiumMg ?? 0) + (b.sodiumMg ?? 0),
  };
}

/** Parse user-entered decimal text ("1.5" or "1,5"). Null if not a number. */
export function parseDecimal(text: string): number | null {
  const n = parseFloat(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Round for display: kcal to whole numbers, grams to one decimal. */
export function fmtKcal(n: number): string {
  return String(Math.round(n));
}

export function fmtGrams(n: number | null): string {
  if (n == null) return '–';
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
