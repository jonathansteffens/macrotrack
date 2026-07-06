import { getUserDb } from './db';
import type { LogEntry, Macros, MealType } from './types';

/**
 * Meal templates ("usual breakfast"): a saved snapshot of a meal's entries
 * that can be re-logged in one tap. Items store their macros at save time —
 * like log entries, they never change retroactively.
 */

export type TemplateItem = {
  foodName: string;
  foodRef: string | null;
  quantityDesc: string;
  grams: number | null;
  macros: Macros;
  source: LogEntry['source'];
};

export type MealTemplate = {
  id: number;
  name: string;
  items: TemplateItem[];
};

export async function saveTemplate(name: string, entries: LogEntry[]): Promise<void> {
  const items: TemplateItem[] = entries.map((e) => ({
    foodName: e.foodName,
    foodRef: e.foodRef,
    quantityDesc: e.quantityDesc,
    grams: e.grams,
    macros: e.macros,
    source: e.source,
  }));
  await getUserDb().runAsync(
    'INSERT INTO meal_templates (name, items_json, created_at) VALUES (?, ?, ?)',
    name,
    JSON.stringify(items),
    new Date().toISOString()
  );
}

export async function listTemplates(): Promise<MealTemplate[]> {
  const rows = await getUserDb().getAllAsync<{ id: number; name: string; items_json: string }>(
    'SELECT id, name, items_json FROM meal_templates ORDER BY id DESC'
  );
  return rows.map((r) => ({ id: r.id, name: r.name, items: JSON.parse(r.items_json) }));
}

export async function deleteTemplate(id: number): Promise<void> {
  await getUserDb().runAsync('DELETE FROM meal_templates WHERE id = ?', id);
}

/** Log every item of a template into the given day + meal. */
export async function logTemplate(
  template: MealTemplate,
  day: string,
  meal: MealType
): Promise<void> {
  const db = getUserDb();
  const ts = new Date().toISOString();
  for (const item of template.items) {
    await db.runAsync(
      `INSERT INTO log_entries
         (day, ts, meal, food_name, food_ref, quantity_desc, grams,
          kcal, protein, carbs, fat, fiber, sugar, sodium_mg, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      day,
      ts,
      meal,
      item.foodName,
      item.foodRef,
      item.quantityDesc,
      item.grams,
      item.macros.kcal,
      item.macros.protein,
      item.macros.carbs,
      item.macros.fat,
      item.macros.fiber,
      item.macros.sugar,
      item.macros.sodiumMg,
      item.source
    );
  }
}

/** Total kcal of a template, for display. */
export function templateKcal(template: MealTemplate): number {
  return template.items.reduce((s, i) => s + i.macros.kcal, 0);
}
