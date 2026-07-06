# MacroTrack

A local-first macro tracking app for iOS/Android. Log food by **search**,
**barcode scan**, or (Phase 2+) **photo/AI assistant**. All data stays on
device. See [PLAN.md](PLAN.md) for the full roadmap.

## Layout

| Path | What |
|---|---|
| `mobile/` | Expo (SDK 57) React Native app |
| `mobile/assets/foods.db` | Bundled USDA food database (~8k generic foods, 2.6 MB) |
| `tools/` | Node pipeline that builds `foods.db` from USDA FoodData Central |

## Phase 1 features (built)

- **Today screen** — daily log grouped by meal, calorie + protein/carb/fat
  totals vs. goals, date navigation, tap any entry to edit or delete
- **Search logging** — offline tokenized search over 8,079 USDA foods plus your
  custom foods; household portions (cup, tbsp, "1 breast"…) with gram weights
- **Barcode scanning** — camera scan (EAN/UPC) or manual digit entry → Open
  Food Facts lookup, cached locally; unknown barcodes flow into a custom-food
  form and scan instantly afterwards
- **Custom foods** — per-100 g nutrition with optional serving size
- **Trends** — 7/30/90-day charts for calories or any macro with goal line,
  averages over logged days, days-logged rate, streak
- **Goals** — daily calorie/protein/carb/fat targets

## Phase 2 features (built — cloud AI)

- **AI assistant** (✨ on the Today screen) — describe a meal in text and/or
  attach a photo (camera or library, auto-downscaled). Claude identifies each
  food, estimates grams, and asks up to 2 clarifying questions (free-text
  answers) when the answer meaningfully changes totals.
- **DB-grounded numbers** — the model outputs identifications + portions;
  final macros come from matching against the bundled USDA/custom foods. Each
  item shows its match, alternatives to switch to, and editable grams. Only
  unmatched items fall back to the model's own estimate, logged as
  `ai_estimate`.
- **Training-data capture** — every AI interaction and the user's final edits
  are stored in `ai_events` (no image bytes), ready to become the Phase 3
  fine-tuning corpus.
- **Setup**: paste an Anthropic API key in Settings (stored in the device
  keychain via SecureStore). Model selectable: Opus 4.8 (default) or
  Haiku 4.5. Structured outputs guarantee valid JSON from the model.

## Phase 3 architecture (built — local model slot, Haiku stand-in)

- **Engine switch** (Settings): `Cloud` (one large-model call) / `Local
  stand-in` / `Auto`. The local engine is a pipeline of three small Haiku
  "subagents" — identify (sees the photo) → quantify → clarify — mirroring how
  the on-device model will decompose the task; swapping in the real local
  model later means reimplementing `runStage()` in
  [local.ts](mobile/src/lib/ai/local.ts) with on-device inference.
- **Auto fallback**: local first; escalates to cloud on error or mean
  confidence < 0.45. The assist screen shows which engine answered.
- **Eval harness** (`tools/eval/`): `build-cases.mjs` generates meal
  descriptions with ground truth computed from the bundled USDA data;
  `run-eval.mjs --model <id>` runs the shipped prompt + schema end-to-end
  (claim → DB resolution → macros) and reports kcal MAPE, protein MAE, item
  accuracy, DB match rate, and over-asking rate. Compare Opus vs Haiku today;
  judge the fine-tuned local model against the same bar later.

## Phase 4 features (built)

- **Meal templates** — ☆ on any meal header saves it; one tap in Add food
  re-logs the whole meal ("usual breakfast").
- **Weight tracking** — quick entry + sparkline + range delta on Trends.
- **Trends v2** — 7-day moving-average line over the daily bars.
- Deferred (need a dev build, not Expo Go): HealthKit / Health Connect sync,
  home-screen widgets, llama.rn on-device inference.

## Fine-tune prep (built — training itself runs elsewhere)

- **Data export** (Settings → Your data): AI training data (ai_events JSONL)
  and full food log via the system share sheet.
- **Synthetic SFT generator** (`tools/finetune/generate-synthetic.mjs`):
  composes meals from foods.db so gold labels (grams, macros, search terms,
  clarifying questions) are exact by construction; reproducible via `--seed`;
  optional paraphrase pass.
- **Research + handoff**: [docs/FINETUNE.md](docs/FINETUNE.md) (student:
  Qwen2.5-VL-3B → llama.rn GGUF; data: Nutrition5k + synthetic + app
  corrections) and [docs/finetune-handoff-prompt.md](docs/finetune-handoff-prompt.md)
  (self-contained prompt for the training-workstation agent).

## Running it

```powershell
cd mobile
npm install
npx expo start
```

Scan the QR code with **Expo Go** ([iOS](https://apps.apple.com/app/expo-go/id982107779) /
[Android](https://play.google.com/store/apps/details?id=host.exp.exponent)) on a
phone on the same network. Everything in Phase 1 (including SQLite and the
barcode camera) works inside Expo Go — no dev build needed.

Web (`npx expo start --web`) is not supported: expo-sqlite on web requires
extra setup that Phase 1 doesn't include.

## Checks

```powershell
cd mobile
npx tsc --noEmit     # typecheck
npm run lint         # eslint
```

`node tools/test-runtime-logic.mjs` (from the repo root) sanity-checks the
search SQL against the bundled DB and the Open Food Facts API contract.

Rebuilding the food database: see [tools/README.md](tools/README.md).

## Data model notes

- Food nutrition is stored **per 100 g**; log entries snapshot their computed
  macros at log time, so later edits to a food never rewrite history, and
  quantity edits rescale proportionally even if the source food is gone.
- Two SQLite databases: `foods.db` (bundled, replaced on app updates via a
  version key) and `user.db` (log, custom foods, barcode cache, settings —
  never touched by updates).
- Every entry keeps a `source` (`usda` / `barcode` / `custom`) — in later
  phases `ai_estimate` joins the list so trends can show data quality.
