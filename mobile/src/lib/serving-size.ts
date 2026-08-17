/**
 * Parsing a packaged food's serving size off its label text.
 *
 * Kept as its own module with no imports so it can be exercised directly
 * (tools/test-serving-size.mjs) — off.ts pulls in the database layer and cannot
 * run outside the app.
 */

/**
 * Grams from OFF's free-text `serving_size`, or null when it says nothing usable.
 *
 * The field is unstructured label text and comes in a few shapes:
 *   "30 g"              -> 30
 *   "30g"               -> 30
 *   "2 cookies (30 g)"  -> 30    (a parenthesised weight wins — it is the metric one)
 *   "1 cup (240 ml)"    -> 240   (ml ≈ g for the drinks this appears on)
 *   "1.5 oz"            -> 42.5
 *   "1 bar"             -> null  (no metric amount; nothing to convert)
 *
 * A parenthesised metric amount is preferred because "2 cookies (30 g)" means
 * 30 g per serving, not 2. Deliberately conservative: anything unrecognised
 * returns null and the caller falls back to grams rather than inventing a
 * serving weight that would silently scale every macro on the label.
 */
export function parseServingSize(text: unknown): number | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.toLowerCase();
  const OZ_G = 28.3495;
  // Every "<number><unit>" pair in the string, in order.
  const matches = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grams?|ml|l|oz|ounces?)\b/g)];
  if (!matches.length) return null;
  // Prefer one inside parentheses — that is the metric restatement of a
  // household measure ("2 cookies (30 g)").
  const inParens = matches.find((m) => {
    const before = s.slice(0, m.index ?? 0);
    return before.lastIndexOf('(') > before.lastIndexOf(')');
  });
  const [, rawNum, rawUnit] = inParens ?? matches[0];
  const n = Number(String(rawNum).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const grams =
    rawUnit === 'kg' ? n * 1000
    : rawUnit === 'l' ? n * 1000
    : rawUnit.startsWith('oz') || rawUnit.startsWith('ounce') ? n * OZ_G
    : n; // g / gr / gram(s) / ml — ml treated as g, as elsewhere in the app
  // Guard against label noise ("100 g" net weight of a 2 kg sack, stray years).
  return grams > 0 && grams <= 2000 ? Math.round(grams * 10) / 10 : null;
}
