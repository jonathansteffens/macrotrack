export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEALS: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
};

/** Nutrient amounts. For foods these are per 100 g; for log entries, per entry. */
export type Macros = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sugar: number | null;
  sodiumMg: number | null;
};

export type Portion = { label: string; grams: number };

export type FoodSource = 'usda' | 'custom' | 'barcode' | 'recipe';

/**
 * A loggable food. `ref` is a stable pointer: 'usda:<fdcId>',
 * 'custom:<id>', or 'barcode:<code>' (resolved through the barcode cache).
 */
export type FoodItem = {
  ref: string;
  source: FoodSource;
  name: string;
  brand: string | null;
  category: string | null;
  per100: Macros;
  /** Base unit for amounts. Defaults to grams; 'ml' for liquids (mL ≈ g). */
  unit?: 'g' | 'ml';
  portions: Portion[];
};

export type LogEntry = {
  id: number;
  day: string; // local YYYY-MM-DD
  ts: string; // ISO timestamp
  meal: MealType;
  foodName: string;
  foodRef: string | null;
  quantityDesc: string;
  grams: number | null;
  unit?: 'g' | 'ml';
  macros: Macros;
  source: FoodSource | 'manual' | 'ai_estimate';
};

export type Goals = { kcal: number; protein: number; carbs: number; fat: number };

export const DEFAULT_GOALS: Goals = { kcal: 2000, protein: 150, carbs: 200, fat: 65 };
