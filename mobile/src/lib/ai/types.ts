/**
 * The structured claim the AI estimator emits. Design principle: the model
 * identifies foods and estimates portions; it never invents final nutrition
 * numbers when a database match exists. `est_per100` is the fallback used
 * only when no local food matches.
 */

export type ClaimItem = {
  /** Plain food name, e.g. "grilled chicken breast" */
  name: string;
  /**
   * v2: how many discrete units the user stated (2 for "two burgers", 0.5 for
   * "half a pizza"); null when the amount isn't a whole-unit count (gram
   * weights, cups/tablespoons, vague amounts).
   */
  count: number | null;
  /**
   * v2: estimated grams of ONE unit when `count` is set; null when `count` is
   * null. The app computes the total as count × unit_grams (see resolver.ts).
   */
  unit_grams: number | null;
  /** Model's total estimate in grams; count × unit_grams wins when count is set */
  grams: number;
  /** Preparation notes affecting nutrition, e.g. "fried in butter" */
  prep: string | null;
  /** 0–1 confidence in the identification + portion estimate */
  confidence: number;
  /** USDA-style search phrases, most specific first */
  db_search_terms: string[];
  /** Model's own per-100g estimate — used only if DB matching fails */
  est_per100: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
  };
};

export type FoodClaim = {
  items: ClaimItem[];
  needs_clarification: boolean;
  /**
   * At most 2 short questions, only when the answer meaningfully changes
   * the estimate (hidden fats, ambiguous portion, ambiguous food).
   */
  questions: string[];
  meal_guess: 'breakfast' | 'lunch' | 'dinner' | 'snack';
};

/** One user input turn: text and/or a photo. */
export type EstimateInput = {
  text?: string;
  /** base64 JPEG, already resized */
  imageBase64?: string;
};

/** Conversation state carried across clarification rounds. */
export type EstimateTurn =
  | { role: 'user'; input: EstimateInput }
  | { role: 'assistant'; claim: FoodClaim };
