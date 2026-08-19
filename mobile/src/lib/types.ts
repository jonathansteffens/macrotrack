export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEALS: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
};

/**
 * Best-guess meal when the user hasn't picked one, from the time of day:
 * 4–10:30am breakfast, 10:30am–2:30pm lunch, 4:30–9:30pm dinner, with snack
 * covering only the genuine between-meals windows (mid-afternoon and late
 * night). The old map left 3–5pm and 9pm+ defaulting to snack, which read as
 * "not time-based at all" at dinnertime. Entries can always be re-filed later.
 */
export function mealForTime(date = new Date()): MealType {
  const mins = date.getHours() * 60 + date.getMinutes();
  if (mins >= 4 * 60 && mins < 10 * 60 + 30) return 'breakfast';
  if (mins >= 10 * 60 + 30 && mins < 14 * 60 + 30) return 'lunch';
  if (mins >= 16 * 60 + 30 && mins < 21 * 60 + 30) return 'dinner';
  return 'snack';
}

/** Nutrient amounts. For foods these are per 100 g; for log entries, per entry. */
export type Macros = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sugar: number | null;
  sodiumMg: number | null;
  satFat: number | null;
  cholesterolMg: number | null;
  calciumMg: number | null;
  ironMg: number | null;
  potassiumMg: number | null;
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
  /**
   * Friendly, human-readable name for display (foods.db `display_name`, e.g.
   * "Chicken breast, roasted"). Present for ~3.7k curated USDA rows; null/absent
   * otherwise. UI falls back to `name`. Search still keys off the canonical name.
   */
  displayName?: string | null;
  /** Base unit for amounts. Defaults to grams; 'ml' for liquids (mL ≈ g). */
  unit?: 'g' | 'ml';
  /** Barcode foods only: nutrition was hand-corrected from the label, so the
   *  cached row is authoritative and never refreshed from Open Food Facts. */
  userEdited?: boolean;
  portions: Portion[];
  /**
   * foods.db provenance ('sr_legacy' | 'survey' | 'foundation' | 'branded').
   * 'branded' = restaurant menu item whose portions[0] is the real serving —
   * the AI resolver snaps gram guesses to whole servings for these.
   */
  dataType?: string | null;
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
  /**
   * How the entry was created, when that differs from a plain food log —
   * 'assist' marks the AI-review flow so the row shows the "AI" provenance chip
   * even when it matched a canonical DB food (`source` still holds the macro
   * provenance). Absent/null for ordinary logs.
   */
  origin?: 'assist' | null;
};
