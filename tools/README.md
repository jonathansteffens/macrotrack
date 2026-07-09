# Food database pipeline

Builds `mobile/assets/foods.db` (bundled generic-food database) from USDA
FoodData Central CSV dumps: SR Legacy (~7.8k foods, includes the branded
"Fast Foods"/"Restaurant Foods" categories) + Foundation Foods (~400 foods,
preferred on name collisions) + FNDDS survey foods (restaurant/mixed dishes
like "Burrito bowl, with beans", "Pad Thai", "Coffee, Latte").

The full merge (~13.3k, exact-name dupes dropped) is kept — the on-device
model's search terms and the SFT/eval pipeline's gold labels resolve against
**all** of it. But each food also gets a `common` tier (0/1/2) that drives a
cleaner **manual** search:

- `2` primary generic — a single food further specified with comma qualifiers
  ("Rice, white, cooked", "Banana, raw", "Chicken, …, breast, meat only,
  roasted"). Ranked first when a person types a food.
- `1` everyday food — FNDDS dishes, branded fast food, "Rice milk".
- `0` reference-only — baby foods, FNDDS "skin eaten / NS as to cooking method"
  survey artifacts. Hidden from manual typing; the AI resolver still uses them.

`searchFoods(query, limit, scope)` in `mobile/src/lib/foods.ts` filters to
`common >= 1` for manual typing (`scope: 'common'`, the default) and uses the
whole table for the AI resolver (`scope: 'all'`). Bump `FOODS_DB_VERSION` in
`mobile/src/lib/db.ts` after any rebuild.

Nutrients are stored **per 100 g**: kcal, protein, carbs, fat, fiber, sugar,
sodium, saturated fat, cholesterol, calcium, iron, potassium. Household
portion labels with gram weights are stored as JSON per food.

## Rebuild

```powershell
# 1. Download + extract source data (~35 MB, not committed)
curl.exe -L -o tools/data/sr_legacy.zip  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
curl.exe -L -o tools/data/foundation.zip "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-12-18.zip"
curl.exe -L -o tools/data/survey.zip     "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip"
Expand-Archive tools/data/sr_legacy.zip  tools/data/sr_legacy  -Force
Expand-Archive tools/data/foundation.zip tools/data/foundation -Force
Expand-Archive tools/data/survey.zip     tools/data/survey     -Force

# 2. Build (requires Node >= 22 for node:sqlite)
node tools/build-food-db.mjs

# 3. Sanity check
node tools/check-db.mjs
```

If USDA publishes a newer release, update the matching `*_DIR` in
`build-food-db.mjs` and the URL above (check
https://fdc.nal.usda.gov/download-datasets for current filenames), then bump
`schema_version` in the meta table if the schema changed. FNDDS quirks the
build script already handles: its `food_nutrient.csv` uses legacy nutrient
*numbers* (sub-1000) instead of FDC ids, categories come from
`wweia_food_category.csv`, and portion labels live in `portion_description`.

Note: `normName` (apostrophes dropped, everything else non-alphanumeric →
space) is duplicated in `mobile/src/lib/norm.ts` and must stay identical.

USDA FoodData Central data is public domain (CC0).

## Other tool directories

- `tools/eval/` — Phase 3 acceptance harness: `build-cases.mjs` (52 text
  cases with DB-derived ground truth), `run-eval.mjs` (scores Anthropic or
  any OpenAI-compatible endpoint), `run-eval-n5k.mjs` (Nutrition5k photo
  eval), `check-overlap.mjs` (verifies eval hold-out from training data).
  `tools/eval/adversarial/` — permanent adversarial eval tier (151 quantity/
  regression/spot cases, born from the v6 QA gate): `run.mjs --list` for a
  no-server case-count dry run, or `--base-url` against a live endpoint.
- `tools/finetune/` — training-data generation (`generate-synthetic.mjs`,
  `fetch-nutrition5k.sh` + `convert-nutrition5k.mjs`), QLoRA training
  (`train_qlora.py`, configs under `runs/`), and GGUF export
  (`export-gguf.sh`). See `docs/FINETUNE.md` and `docs/finetune-report.md`.
