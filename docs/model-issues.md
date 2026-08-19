# Model issues — running list from field testing

Live log of estimator misbehavior observed on-device, for the workstation
(training/eval side) to work through. App-side issues don't belong here — they
get fixed directly on the laptop. Each entry: what was typed, what happened,
what should happen, and any diagnosis already done. The corresponding
`ai_events` export rows (Settings → Export corrections) carry the exact claims
when they were logged.

## Open

### 1. Enumerated ingredient lists get fused into an invented dish
- **Input (device, 2026-08-18):** `200 g of cabbage, carrot, and mushrooms`
- **Observed:** one item, "cabbage and mushroom soup" — a dish the user never
  said, with the carrot dropped entirely.
- **Expected:** three items (or at minimum a mixed-vegetables entry). The
  model must never invent a preparation ("soup") that isn't in the text.
  Open sub-question for the data design: does "200 g of X, Y and Z" mean 200 g
  total (split how — evenly?) or 200 g each? Probably total; a clarification
  question is also acceptable. Gate candidates: enumerated lists with a shared
  leading weight, with and without Oxford comma, 2–4 ingredients.

### 2. "cobb salad" fails to resolve despite a curated DB row
- **Input (device, 2026-08-18):** cobb salad via the assist flow.
- **Observed:** no DB match ("couldn't locate it in the list").
- **DB context:** `Cobb salad, no dressing` EXISTS (common = 1, display name
  "Cobb Salad, no Dressing"), and both manual-search tokens land on it — so
  the model's emitted name/db_search_terms missed a resolvable target. Need
  the ai_events row for the exact claim; suspect the terms named ingredients
  ("lettuce chicken bacon salad"?) rather than the dish.

### 3. llama.rn decodes diverge from llama-server on near-tie inputs (temp 0)
- **Known case:** `A 12 oz can of coke` (capitalized) → garbled claim name
  `coca-col k-coke`, no-match, on BOTH device sessions at c6e5ac9 and 558a36f;
  the same v8 GGUF on workstation llama-server returns a clean claim (368 g).
- **Implication:** gate passes on llama-server don't guarantee device decodes.
  Suggested: a CPU-only llama.cpp decode lane for release candidates, seeded
  with the gate's capitalized/trailing-space variants.

## Resolved (kept for the record)
- "coke"/"cola"/"soda" identity + cocktail-first ranking → fixed app-side via
  curated aliases + cocktail de-rank (c822a6c, 75fe94b); grams fixed by the
  ambiguousOz resolver rule (f1345c6).
