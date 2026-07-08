/**
 * Goal calculator: Mifflin-St Jeor BMR × activity multiplier, shifted for the
 * user's aim, with macros split as protein 1.8 g/kg body weight, fat ~27.5%
 * of calories (middle of the usual 25–30% band), remainder carbs. Purely a
 * suggestion engine — results prefill the normal goal fields and stay
 * editable there.
 */

export type Sex = 'male' | 'female';

export const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: 'Sedentary', factor: 1.2 },
  { key: 'light', label: 'Light', factor: 1.375 },
  { key: 'moderate', label: 'Moderate', factor: 1.55 },
  { key: 'active', label: 'Active', factor: 1.725 },
  { key: 'very_active', label: 'Very active', factor: 1.9 },
] as const;

export type ActivityKey = (typeof ACTIVITY_LEVELS)[number]['key'];

export const GOAL_AIMS = [
  { key: 'lose', label: 'Lose', kcalDelta: -500 },
  { key: 'maintain', label: 'Maintain', kcalDelta: 0 },
  { key: 'gain', label: 'Gain', kcalDelta: 300 },
] as const;

export type AimKey = (typeof GOAL_AIMS)[number]['key'];

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export type GoalSuggestion = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
};

/** Mifflin-St Jeor: 10W + 6.25H − 5A, +5 for men / −161 for women. */
export function bmrMifflinStJeor(
  sex: Sex,
  weightKg: number,
  heightCm: number,
  ageYears: number
): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + (sex === 'male' ? 5 : -161);
}

export function suggestGoals(input: {
  sex: Sex;
  ageYears: number;
  weightKg: number;
  heightCm: number;
  activity: ActivityKey;
  aim: AimKey;
}): GoalSuggestion {
  const factor = ACTIVITY_LEVELS.find((a) => a.key === input.activity)?.factor ?? 1.2;
  const delta = GOAL_AIMS.find((a) => a.key === input.aim)?.kcalDelta ?? 0;
  const tdee = bmrMifflinStJeor(input.sex, input.weightKg, input.heightCm, input.ageYears) * factor;
  const kcal = Math.max(0, Math.round((tdee + delta) / 10) * 10);
  const protein = Math.round(1.8 * input.weightKg);
  const fat = Math.round((kcal * 0.275) / 9);
  const carbs = Math.round(Math.max(0, (kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein, carbs, fat };
}
