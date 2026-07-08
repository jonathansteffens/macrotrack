/**
 * Search normalization for food names. Apostrophes are dropped (not split) so
 * "McDONALD'S" matches a search for "mcdonalds"; every other non-alphanumeric
 * run becomes a single space. MUST stay in sync with normName in
 * tools/build-food-db.mjs — the bundled foods.db stores names normalized the
 * same way.
 */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
