import { MacroColors } from '@/constants/theme';
import { fmtGrams, fmtKcal } from './macros';
// Type-only: tracking.ts imports NUTRIENTS at runtime, so a value import here
// would be a cycle.
import type { TrackingConfig } from './tracking';
import type { Macros } from './types';

/**
 * The registry of trackable nutrients. Everything the app can track lives here
 * once; the Today screen, Trends, and Settings all iterate this list, so adding
 * a nutrient (once its data flows through the pipeline) is a single entry.
 *
 * A nutrient's `key` is exactly its field on Macros — that's how values are read
 * generically via nutrientValue(). Defaults seed a fresh install and pre-fill a
 * goal when the user first enables a nutrient.
 */

export type NutrientKey = keyof Macros;

export type NutrientDef = {
  key: NutrientKey;
  label: string;
  /** Unit appended to values; '' for calories. */
  unit: string;
  color: string;
  /** On the Today screen / Trends by default (the classic macros). */
  defaultEnabled: boolean;
  /** Goal pre-filled when the nutrient is enabled; null = track, no target. */
  defaultGoal: number | null;
};

export const NUTRIENTS: NutrientDef[] = [
  { key: 'kcal', label: 'Calories', unit: '', color: MacroColors.kcal, defaultEnabled: true, defaultGoal: 2000 },
  { key: 'protein', label: 'Protein', unit: 'g', color: MacroColors.protein, defaultEnabled: true, defaultGoal: 150 },
  { key: 'carbs', label: 'Carbs', unit: 'g', color: MacroColors.carbs, defaultEnabled: true, defaultGoal: 200 },
  { key: 'fat', label: 'Fat', unit: 'g', color: MacroColors.fat, defaultEnabled: true, defaultGoal: 65 },
  // Off by default: the classic-four macros are the fresh-install baseline; fiber
  // and everything below live under "More nutrients" (opt-in).
  { key: 'fiber', label: 'Fiber', unit: 'g', color: MacroColors.fiber, defaultEnabled: false, defaultGoal: 30 },
  { key: 'sugar', label: 'Sugar', unit: 'g', color: MacroColors.sugar, defaultEnabled: false, defaultGoal: null },
  { key: 'sodiumMg', label: 'Sodium', unit: 'mg', color: MacroColors.sodium, defaultEnabled: false, defaultGoal: 2300 },
  { key: 'satFat', label: 'Saturated fat', unit: 'g', color: MacroColors.satFat, defaultEnabled: false, defaultGoal: 20 },
  { key: 'cholesterolMg', label: 'Cholesterol', unit: 'mg', color: MacroColors.cholesterol, defaultEnabled: false, defaultGoal: 300 },
  { key: 'calciumMg', label: 'Calcium', unit: 'mg', color: MacroColors.calcium, defaultEnabled: false, defaultGoal: 1300 },
  { key: 'ironMg', label: 'Iron', unit: 'mg', color: MacroColors.iron, defaultEnabled: false, defaultGoal: 18 },
  { key: 'potassiumMg', label: 'Potassium', unit: 'mg', color: MacroColors.potassium, defaultEnabled: false, defaultGoal: 4700 },
];

export const NUTRIENTS_BY_KEY: Record<NutrientKey, NutrientDef> = Object.fromEntries(
  NUTRIENTS.map((n) => [n.key, n])
) as Record<NutrientKey, NutrientDef>;

/**
 * The classic four macros — always shown/primary. Everything else is a
 * secondary "micronutrient" surfaced behind a "More nutrients" affordance in
 * onboarding, custom-food, and the food detail preview.
 */
export const CORE_NUTRIENT_KEYS: NutrientKey[] = ['kcal', 'protein', 'carbs', 'fat'];

/** Read a nutrient's amount off a Macros total; missing/unknown reads as 0. */
export function nutrientValue(m: Macros, key: NutrientKey): number {
  return m[key] ?? 0;
}

/** The nutrients a summary line should show: the user's tracked set (defaults
 *  while prefs load), with calories as the never-empty fallback. */
export function trackedNutrients(tracking: TrackingConfig | null): NutrientDef[] {
  const defs = NUTRIENTS.filter((n) => tracking?.[n.key].enabled ?? n.defaultEnabled);
  return defs.length > 0 ? defs : NUTRIENTS.filter((n) => n.key === 'kcal');
}

/** "245 kcal · Protein 32 g · Fiber 3 g" — tracked nutrients only, so every
 *  summary line in the app shows the user's chosen set, not the classic four. */
export function trackedNutrientLine(m: Macros, tracking: TrackingConfig | null): string {
  return trackedNutrients(tracking)
    .map((n) => {
      const v = nutrientValue(m, n.key);
      if (n.key === 'kcal') return `${fmtKcal(v)} kcal`;
      const val = n.unit === 'mg' ? String(Math.round(v)) : fmtGrams(v);
      return `${n.label} ${val} ${n.unit}`;
    })
    .join(' · ');
}
