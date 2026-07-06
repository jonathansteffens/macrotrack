# Food database pipeline

Builds `mobile/assets/foods.db` (bundled generic-food database) from USDA
FoodData Central CSV dumps: SR Legacy (~7.8k foods) + Foundation Foods (~400
foods, preferred on name collisions). Nutrients are stored **per 100 g**:
kcal, protein, carbs, fat, fiber, sugar, sodium. Household portion labels with
gram weights are stored as JSON per food.

## Rebuild

```powershell
# 1. Download + extract source data (~30 MB, not committed)
curl.exe -L -o tools/data/sr_legacy.zip  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
curl.exe -L -o tools/data/foundation.zip "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-12-18.zip"
Expand-Archive tools/data/sr_legacy.zip  tools/data/sr_legacy  -Force
Expand-Archive tools/data/foundation.zip tools/data/foundation -Force

# 2. Build (requires Node >= 22 for node:sqlite)
node tools/build-food-db.mjs

# 3. Sanity check
node tools/check-db.mjs
```

If USDA publishes a newer Foundation release, update `FN_DIR` in
`build-food-db.mjs` and the URL above (check
https://fdc.nal.usda.gov/download-datasets for current filenames), then bump
`schema_version` in the meta table if the schema changed.

USDA FoodData Central data is public domain (CC0).

## Other tool directories

- `tools/eval/` — Phase 3 acceptance harness: `build-cases.mjs` (52 text
  cases with DB-derived ground truth), `run-eval.mjs` (scores Anthropic or
  any OpenAI-compatible endpoint), `run-eval-n5k.mjs` (Nutrition5k photo
  eval), `check-overlap.mjs` (verifies eval hold-out from training data).
- `tools/finetune/` — training-data generation (`generate-synthetic.mjs`,
  `fetch-nutrition5k.sh` + `convert-nutrition5k.mjs`), QLoRA training
  (`train_qlora.py`, configs under `runs/`), and GGUF export
  (`export-gguf.sh`). See `docs/FINETUNE.md` and `docs/finetune-report.md`.
