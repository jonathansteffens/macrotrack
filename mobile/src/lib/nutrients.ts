import { MacroColors } from '@/constants/theme';
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
  { key: 'fiber', label: 'Fiber', unit: 'g', color: MacroColors.fiber, defaultEnabled: true, defaultGoal: 30 },
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

/** Read a nutrient's amount off a Macros total; missing/unknown reads as 0. */
export function nutrientValue(m: Macros, key: NutrientKey): number {
  return m[key] ?? 0;
}
