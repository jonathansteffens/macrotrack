/**
 * JSON Schema enforced via structured outputs (output_config.format), so the
 * API guarantees the response parses as a valid FoodClaim. Mirrors
 * ./types.ts — keep the two in sync.
 *
 * Constraint notes: structured outputs don't support numeric min/max or
 * string length limits, so bounds (confidence 0–1, ≤2 questions) are stated
 * in the system prompt and clamped in code.
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
          grams: { type: 'number', description: 'Estimated amount in grams' },
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
        required: ['name', 'grams', 'prep', 'confidence', 'db_search_terms', 'est_per100'],
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
