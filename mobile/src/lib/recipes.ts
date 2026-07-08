import { getUserDb } from './db';
import { addMacros, rescaleMacros, scaleMacros, ZERO_MACROS } from './macros';
import type { FoodItem, Macros } from './types';

/**
 * Recipes: a reusable, multi-ingredient food. Each ingredient snapshots its
 * per-100g macros at add time (like log entries, so it never changes under
 * you). The recipe's total is the weighted sum of its ingredients; one
 * serving is total ÷ servings.
 *
 * A saved recipe is exposed as an ordinary FoodItem via recipeToFood(), with
 * a "1 serving" portion — so logging flows through the normal food screen and
 * resolver, no special-case path.
 */

export type RecipeItem = {
  foodName: string;
  foodRef: string | null; // pointer to the source food, if any
  grams: number;
  per100: Macros; // snapshot
};

export type Recipe = {
  id: number;
  name: string;
  servings: number;
  items: RecipeItem[];
};

type RecipeRow = { id: number; name: string; servings: number };
type ItemRow = {
  food_name: string;
  food_ref: string | null;
  grams: number;
  per100_json: string;
};

function itemFromRow(r: ItemRow): RecipeItem {
  return {
    foodName: r.food_name,
    foodRef: r.food_ref,
    grams: r.grams,
    per100: JSON.parse(r.per100_json),
  };
}

/** Build a recipe item snapshot from a resolved food + an amount. */
export function recipeItemFromFood(food: FoodItem, grams: number): RecipeItem {
  return { foodName: food.name, foodRef: food.ref, grams, per100: food.per100 };
}

/** Create (id omitted) or replace (id given) a recipe and all its items. */
export async function saveRecipe(input: {
  id?: number;
  name: string;
  servings: number;
  items: RecipeItem[];
}): Promise<number> {
  const db = getUserDb();
  const name = input.name.trim() || 'Untitled recipe';
  const servings = Math.max(input.servings, 0.1);

  let id = input.id;
  if (id == null) {
    const res = await db.runAsync(
      'INSERT INTO recipes (name, servings, created_at) VALUES (?, ?, ?)',
      name,
      servings,
      new Date().toISOString()
    );
    id = res.lastInsertRowId;
  } else {
    await db.runAsync('UPDATE recipes SET name = ?, servings = ? WHERE id = ?', name, servings, id);
    await db.runAsync('DELETE FROM recipe_items WHERE recipe_id = ?', id);
  }
  for (const it of input.items) {
    await db.runAsync(
      'INSERT INTO recipe_items (recipe_id, food_name, food_ref, grams, per100_json) VALUES (?, ?, ?, ?, ?)',
      id,
      it.foodName,
      it.foodRef,
      it.grams,
      JSON.stringify(it.per100)
    );
  }
  return id;
}

export async function getRecipe(id: number): Promise<Recipe | null> {
  const row = await getUserDb().getFirstAsync<RecipeRow>(
    'SELECT id, name, servings FROM recipes WHERE id = ?',
    id
  );
  if (!row) return null;
  const items = await getUserDb().getAllAsync<ItemRow>(
    'SELECT food_name, food_ref, grams, per100_json FROM recipe_items WHERE recipe_id = ? ORDER BY id',
    id
  );
  return { id: row.id, name: row.name, servings: row.servings, items: items.map(itemFromRow) };
}

export async function listRecipes(): Promise<Recipe[]> {
  const rows = await getUserDb().getAllAsync<RecipeRow>(
    'SELECT id, name, servings FROM recipes ORDER BY id DESC'
  );
  const out: Recipe[] = [];
  for (const row of rows) {
    const r = await getRecipe(row.id);
    if (r) out.push(r);
  }
  return out;
}

export async function deleteRecipe(id: number): Promise<void> {
  const db = getUserDb();
  await db.runAsync('DELETE FROM recipe_items WHERE recipe_id = ?', id);
  await db.runAsync('DELETE FROM recipes WHERE id = ?', id);
}

// ---- Aggregation ----

export function recipeTotalGrams(recipe: Recipe): number {
  return recipe.items.reduce((s, it) => s + it.grams, 0);
}

/** Macros for the whole batch (all ingredients summed). */
export function recipeTotals(recipe: Recipe): Macros {
  return recipe.items.reduce(
    (sum, it) => addMacros(sum, scaleMacros(it.per100, it.grams)),
    ZERO_MACROS
  );
}

/** Macros for one serving = total ÷ servings. */
export function recipePerServing(recipe: Recipe): Macros {
  const s = Math.max(recipe.servings, 0.1);
  return rescaleMacros(recipeTotals(recipe), 1 / s);
}

/**
 * Expose a recipe as a loggable FoodItem: per-100g is the batch's weighted
 * average, and portions offer "1 serving" (the natural unit) and the whole
 * recipe. Logging then goes through the standard food screen.
 */
export function recipeToFood(recipe: Recipe): FoodItem {
  const totalGrams = recipeTotalGrams(recipe);
  const f = totalGrams > 0 ? 100 / totalGrams : 0;
  const per100: Macros = rescaleMacros(recipeTotals(recipe), f);
  const servingGrams = totalGrams / Math.max(recipe.servings, 0.1);
  const portions =
    totalGrams > 0
      ? [
          { label: `1 serving (of ${recipe.servings})`, grams: servingGrams },
          { label: 'Whole recipe', grams: totalGrams },
        ]
      : [];
  return {
    ref: `recipe:${recipe.id}`,
    source: 'recipe',
    name: recipe.name,
    brand: null,
    category: null,
    per100,
    portions,
  };
}
