/**
 * JSON Schema enforced via structured outputs (output_config.format), so the
 * API guarantees the response parses as a valid FoodClaim. Mirrors
 * ./types.ts — keep the two in sync.
 *
 * Constraint notes: structured outputs don't support numeric min/max or
 * string length limits, so bounds (confidence 0–1, ≤2 questions) are stated
 * in the system prompt and clamped in code.
 *
 * Schema v2: each item carries `count` + `unit_grams` (both nullable) so the
 * model reports a unit count and the grams of one unit rather than multiplying
 * itself — the app does the math (count × unit_grams). Ordered before `grams`
 * because llama.cpp compiles the grammar in schema order and the model should
 * emit the count and per-unit weight before the total. See resolver.ts.
 */
export const FOOD_CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plain food name' },
          count: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'How many discrete units the user stated (10 for "10 tacos", 2 for "two burgers", 0.5 for "half a pizza", 12 for "a dozen"); null when the amount is not a count of whole units (gram weights, cups/tablespoons, vague amounts)',
          },
          unit_grams: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'Estimated grams of ONE unit when count is set (one soft taco ≈ 100, one egg ≈ 50); null when count is null. The app computes the total as count × unit_grams',
          },
          grams: {
            type: 'number',
            description: "The model's total estimate in grams; when count is set the app uses count × unit_grams instead, so that takes precedence",
          },
          prep: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Preparation affecting nutrition (e.g. "fried in butter"), or null',
          },
          confidence: {
            type: 'number',
            description: 'Confidence 0-1 in identification and portion',
          },
          db_search_terms: {
            type: 'array',
            items: { type: 'string' },
            description: 'USDA-style search phrases, most specific first',
          },
          est_per100: {
            type: 'object',
            description: 'Your own per-100g estimate, used only if database matching fails',
            properties: {
              kcal: { type: 'number' },
              protein: { type: 'number' },
              carbs: { type: 'number' },
              fat: { type: 'number' },
            },
            required: ['kcal', 'protein', 'carbs', 'fat'],
            additionalProperties: false,
          },
        },
        required: ['name', 'count', 'unit_grams', 'grams', 'prep', 'confidence', 'db_search_terms', 'est_per100'],
        additionalProperties: false,
      },
    },
    needs_clarification: { type: 'boolean' },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'At most 2 clarifying questions; empty when confident',
    },
    meal_guess: {
      type: 'string',
      enum: ['breakfast', 'lunch', 'dinner', 'snack'],
    },
  },
  required: ['items', 'needs_clarification', 'questions', 'meal_guess'],
  additionalProperties: false,
} as const;
