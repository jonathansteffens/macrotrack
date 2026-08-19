# Model issues — running list from field testing

Live log of estimator misbehavior observed on-device, for the workstation
(training/eval side) to work through. App-side issues don't belong here — they
get fixed directly on the laptop. Each entry: what was typed, what happened,
what should happen, and any diagnosis already done. The corresponding
`ai_events` export rows (Settings → Export corrections) carry the exact claims
when they were logged.

## Open

### 0. PRIORITY — invented estimates for out-of-database foods are far off in the field
- **Field observation (Jon, 2026-08-19):** whenever an item fails to resolve
  against foods.db, the model's own est_per100 fallback is "always really far
  from anything that makes sense" — despite the offline eval measuring ~2%
  median APE on est_per100. That mismatch is the finding: the eval's OOD cases
  are not the field's OOD cases. Field failures correlate with IDENTITY
  fabrication (issues 1–3): the model invents a dish ("cabbage and mushroom
  soup") or emits a garbled name, and its est_per100 is then internally
  consistent with the invented identity — accurate arithmetic on a wrong food.
- **App-side change (shipped 2026-08-19):** the assist review no longer counts
  est_per100 silently. Unmatched items render as "Couldn't find this in the
  food database" with [Search the database] / [Use AI estimate anyway];
  unresolved items are excluded from totals and from logging, and record as
  'remove' edits in ai_events — so every field failure of this class now
  produces a labeled training signal automatically.
- **Training/eval work order (Jon: "explicitly train and test on this
  extensively"):**
  1. Anti-fabrication training: the model must never emit a dish/preparation
     not present in the text; enumerated ingredients stay enumerated;
     unfamiliar foods keep the user's own wording as the name (verbatim-name
     bias) so DB search gets an honest shot.
  2. A field-OOD eval lane built from real ai_events no-match cases (the
     exports carry them), scored on: identity fidelity to the user's words,
     and est_per100 accuracy against reference values for the TRUE food.
  3. Decode-stability coverage (issue 3) folded in: the garbled-name class is
     an instance of this problem.

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

### 4. Resolver search should converge with the human-facing manual search
- **Field observation (Jon, 2026-08-19):** an AI-matched item can differ from
  what manually searching the same words shows — confusing now that the
  assist flow is DB-match-only (no silent inventions).
- **Why they diverge:** the resolver's 'all'-scope search + ranking is the
  model's TRAINING CONTRACT (db_search_terms are optimized against it; the
  gate mirrors it byte-for-byte), so it stayed frozen while manual search
  gained the common-tier subset, display-name bridge, plural-awareness, and
  cocktail de-rank. Only alias + de-rank + display-stage made it into the
  resolver (c822a6c).
- **Work order:** next training round, update the resolver search to the
  manual-search semantics (plural-aware tiers at minimum), regenerate
  training data + gate cases against it, and retrain so model terms target
  the search humans actually see. All four SQL mirrors move together.

## Resolved (kept for the record)
- "coke"/"cola"/"soda" identity + cocktail-first ranking → fixed app-side via
  curated aliases + cocktail de-rank (c822a6c, 75fe94b); grams fixed by the
  ambiguousOz resolver rule (f1345c6).
