# MacroTrack — Build Plan

A cross-platform (iOS/Android) macro tracking app with three logging modes — text entry, barcode scan, photo — backed by an AI assistant that asks clarifying questions when needed, estimates full nutrition, and tracks history and trends. Target: the AI model runs **on-device**, with a cloud fallback during development and for low-end phones.

---

## 1. Core design principle: the LLM identifies, the database quantifies

The single most important architectural decision. Small models are bad at reciting nutrition facts (they hallucinate calorie numbers), but they are good at *parsing and perception*. So split responsibilities:

- **The model's job:** turn messy input (free text, a photo, a conversation) into a structured claim: *"grilled chicken breast, ~170 g"* + *"steamed broccoli, ~1 cup"* + a confidence score + clarifying questions if confidence is low.
- **The database's job:** map that claim to canonical nutrition data (USDA / Open Food Facts) and scale by quantity. Deterministic, auditable, no hallucinated macros.
- **Model as fallback only:** if a food genuinely isn't in the database (homemade ethnic dish, restaurant item), the model estimates macros directly, clearly flagged as an estimate.

This makes the on-device model problem *much* smaller: it needs to be a decent food-recognition and portion-estimation model with structured output, not a nutrition encyclopedia. That's a realistic fine-tuning target for a 2–4B model.

---

## 2. System architecture

```
┌─────────────────────────────────────────────────────┐
│  App (React Native + Expo)                          │
│                                                     │
│  Input layer                                        │
│   ├─ Text entry ──────────────┐                     │
│   ├─ Barcode scan (camera) ───┼──► Resolver         │
│   └─ Photo (camera/library) ──┘        │            │
│                                        ▼            │
│  AI layer                        ┌───────────┐      │
│   ├─ On-device VLM (fine-tuned)  │ Food      │      │
│   ├─ Cloud fallback (optional)   │ Resolver  │      │
│   └─ Clarification chat UI       └─────┬─────┘      │
│                                        ▼            │
│  Data layer                                         │
│   ├─ SQLite: logs, custom foods, chat, prefs        │
│   ├─ Bundled food DB (USDA FDC subset, ~20k foods)  │
│   ├─ Barcode cache + Open Food Facts API            │
│   └─ HealthKit / Health Connect export              │
│                                                     │
│  Presentation                                       │
│   ├─ Daily log + macro rings/bars vs. goals         │
│   ├─ Trends (7/30/90-day charts, streaks)           │
│   └─ History browser + search                       │
└─────────────────────────────────────────────────────┘
```

### The Resolver (heart of the app)

Every input path converges on one pipeline:

1. **Parse** → structured `FoodClaim[]` (from barcode lookup, text parse, or photo analysis)
2. **Match** → search local food DB (FTS5 full-text + embedding similarity for fuzzy matches); fall back to USDA/OFF API if online
3. **Clarify** → if match ambiguity or portion uncertainty exceeds a threshold, the assistant asks 1–2 targeted questions ("Was the chicken skin-on?" / "Roughly how big — palm-sized or larger?")
4. **Quantify** → scale canonical per-100g data by estimated quantity
5. **Log** → write entry; user can always tap-to-correct (corrections become training data)

### Structured output schema (what the model must emit)

```json
{
  "items": [
    {
      "name": "grilled chicken breast",
      "quantity": 170, "unit": "g",
      "prep": "grilled, no skin",
      "confidence": 0.72,
      "db_search_terms": ["chicken breast grilled skinless"]
    }
  ],
  "needs_clarification": true,
  "questions": [
    {
      "text": "Is there dressing on the salad?",
      "options": ["No dressing", "Vinaigrette", "Ranch/creamy", "Other"],
      "impacts": "fat estimate ±15 g"
    }
  ],
  "meal_guess": "lunch"
}
```

Multiple-choice questions (not open-ended) keep the interaction fast and keep the small model on rails.

---

## 3. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| App framework | **React Native + Expo** (dev builds) | Fastest iteration for a solo dev; mature camera/ML ecosystem. Flutter is a fine alternative if preferred. |
| Camera + barcode | `react-native-vision-camera` + ML Kit barcode plugin | On-device, fast, free, handles EAN/UPC |
| Local DB | SQLite via `expo-sqlite` (or Drizzle ORM) with **FTS5** | Full-text food search offline |
| Charts | `victory-native` or `react-native-skia` charts | Trend views |
| On-device LLM runtime | **llama.cpp via `llama.rn`** (cross-platform) | One runtime for both OSes, GGUF quantized models, supports vision (mmproj) |
| Runtime alternative | MediaPipe LLM Inference (Android) + MLX/Core ML (iOS) | Better per-platform perf, 2× the integration work — only if llama.rn perf disappoints |
| Cloud fallback / teacher | Any large VLM API during dev | Validates UX before the local model exists |
| Health integration | HealthKit / Health Connect | Export calories & macros; import weight for trend correlation |

---

## 4. Food data sources

| Source | Coverage | Use |
|---|---|---|
| **USDA FoodData Central** (public domain) | ~15k Foundation/SR Legacy generic foods + branded | Bundle a curated ~20–30k-item subset in the app (~10–20 MB SQLite). This is the offline backbone. |
| **Open Food Facts** (ODbL, free API + full dumps) | ~3.5M barcoded products worldwide | Barcode lookups. Cache every hit locally. Optionally bundle top-N products by scan frequency. |
| User custom foods & recipes | — | User-created, stored locally; recipe = weighted sum of ingredients |

Notes:
- OFF data is community-sourced and patchy on micronutrients — fine for macros, verify serving sizes.
- Normalize everything to **per-100g** internally; store serving-size conversions separately.
- Keep a `source` field on every logged entry (`barcode`, `db_match`, `ai_estimate`) so trends can show data quality.

---

## 5. AI/model strategy

### Phase A — Cloud model first (weeks 1–6)

Use a large hosted VLM behind a thin API interface (`estimateFood(image|text, context) → FoodClaim JSON`). This:
- Validates the whole UX (especially the clarifying-question flow) before any fine-tuning
- Generates real usage data: (input, model output, user correction) triples — **the most valuable training data you'll get**

### Phase B — Distill to a local model

**Student model candidates** (in preference order):

1. **Gemma 3n E2B/E4B** — multimodal, explicitly designed for on-device, ~2–3 GB quantized, fine-tunable, runs via llama.cpp or MediaPipe. Best overall fit.
2. **Qwen2.5-VL-3B / Qwen3-VL small** — strong VLM baseline, good fine-tuning ecosystem (Unsloth, LLaMA-Factory).
3. **SmolVLM2-2.2B** — smallest viable; try if the above are too slow on mid-range Android.

**Teacher:** a large *open-weight* VLM (Qwen2.5-VL-72B or InternVL-2.5-78B) so distillation is license-clean. (Distilling from closed APIs typically violates ToS.)

**Training data recipe:**

| Source | What it provides |
|---|---|
| **Nutrition5k** (Google) | ~5k real cafeteria dishes with *measured* mass, calories, and macros per ingredient — the gold standard for portion estimation |
| Food-101 / FoodX-251 / UEC-Food-256 | Food classification breadth (101–256 categories) |
| Teacher-generated synthetic dialogues | Take food images + ground truth → teacher produces structured JSON + realistic clarifying-question exchanges. Generate ~20–50k examples. |
| Text-only synthetic | "2 eggs scrambled in butter and a slice of sourdough" → JSON. Cheap to generate at scale, covers the text-entry path. |
| App usage corrections (from Phase A) | Distribution-matched to real users — weight these heavily |

**Training plan:**
- SFT with **QLoRA** (r=16–32) on the student; frozen vision encoder initially, unfreeze last blocks if portion estimation lags
- Enforce the JSON schema in training targets; at inference use grammar-constrained decoding (llama.cpp GBNF) so output is *always* valid JSON
- Quantize to **Q4_K_M** GGUF; verify quality drop on eval set is <2–3%

**Evaluation harness (build before training):**
- Held-out Nutrition5k split: calorie MAE% (target: beat the ~20–30% typical human self-report error), macro MAE (g)
- Food identification: top-1/top-3 accuracy vs. labels
- Portion estimation: mass MAPE
- Question quality: does the model ask when confidence is genuinely low, and stay quiet when it isn't? (measure over-asking rate — asking every time is annoying and a real failure mode)
- JSON validity rate (should be ~100% with constrained decoding)
- On-device: tokens/sec and time-to-first-token on a mid-range Android (target <8s end-to-end for a photo)

### Honest difficulty ranking

1. **Portion size from a single photo is the hardest problem in this space** (unknown camera distance, hidden ingredients, oil/sauce invisible). Mitigations: clarifying questions (the big one), user's own history as prior ("you usually log ~150g chicken"), multiple-choice portion prompts with visual anchors ("palm-sized / deck of cards").
2. Mixed dishes (casseroles, curries) — decompose into ingredients, ask about the 1–2 highest-variance ones.
3. Everything else (barcode, text parse, DB matching) is well-trodden and low-risk.

---

## 6. Data model (SQLite)

```sql
foods(id, name, brand, barcode, source, per100g_kcal, per100g_protein,
      per100g_carbs, per100g_fat, per100g_fiber, serving_sizes_json, verified)
-- FTS5 virtual table on foods(name, brand)

log_entries(id, ts, meal, food_id, quantity_g, kcal, protein_g, carbs_g,
            fat_g, source,            -- barcode | db_match | ai_estimate | manual
            confidence, photo_uri, ai_raw_json, corrected)

recipes(id, name, servings)          -- recipe_items(recipe_id, food_id, grams)

user_profile(goals_json, tdee, units, dietary_prefs)
weights(ts, kg)                      -- optional, for trend correlation
chat_messages(id, entry_id, role, content, ts)   -- clarification threads
```

Local-first; no account required. Optional encrypted cloud backup later.

---

## 7. Build phases

### Phase 1 — Trackable MVP, no AI ✅ built 2026-07-05 (see README.md)
- Expo app scaffold, SQLite schema, bundled USDA subset with FTS search
- Text search → pick food → pick quantity → log
- Barcode scan → OFF lookup → log (with local cache)
- Daily log screen, macro totals vs. goals, basic 7/30-day trend charts
- **Exit criterion: you personally use it daily instead of your current tracker**

### Phase 2 — AI assist via cloud ✅ built 2026-07-05 (Claude API; text-input clarification per decision)
- Free-text natural language entry → cloud VLM → FoodClaim JSON → resolver → log
- Photo capture → same pipeline
- Clarification chat UI (multiple-choice chips, one round-trip)
- Tap-to-correct on every AI entry; store correction pairs
- **Exit criterion: photo-to-logged-meal in <20s with acceptable accuracy on your real meals**

### Phase 3 — Local model 🟡 everything but the training run built 2026-07-06 (stand-in live; data pipeline, eval harness, export, research + handoff prompt in docs/; fine-tune runs on the workstation per docs/finetune-handoff-prompt.md)
- Build eval harness first (Nutrition5k splits + your own logged corrections)
- Generate synthetic training set with open teacher; QLoRA fine-tune Gemma 3n E4B
- Quantize, integrate llama.rn, grammar-constrained JSON decoding
- Settings toggle: local / cloud / auto (local with cloud fallback under low confidence)
- **Exit criterion: local model within ~10% of teacher on eval, <8s on-device**

### Phase 4 — Polish & retention 🟡 templates/weight/trends-v2 built 2026-07-05 (HealthKit + widgets deferred to dev build)
- Trends v2: weekly summaries, moving averages, protein streaks, weight-vs-intake correlation
- HealthKit / Health Connect sync
- Home-screen widgets, quick-log favorites ("usual breakfast")
- Recipes & meal templates
- Periodic re-fine-tune with accumulated corrections

---

## 8. Key risks

| Risk | Mitigation |
|---|---|
| Portion estimation accuracy caps user trust | Clarifying questions + easy correction UX + show confidence; never present estimates as exact |
| Local model too slow on mid-range Android | E2B (smaller) variant, more aggressive quant, or auto-fallback to cloud; keep the cloud path permanently as an option |
| Over-asking questions annoys users | Train/tune the ask-threshold explicitly; cap at 2 questions per meal; learn user habits to pre-answer |
| OFF barcode data quality | Show the fetched label to the user on first scan; allow one-tap edit; cache corrections |
| iOS memory limits (~3GB app ceiling on older phones) | E2B at Q4 is ~1.5 GB; load model on demand, unload on background |
| Scope creep (micronutrients, social features, …) | Macros + calories + fiber only until Phase 4 ships |

---

## 9. Open decisions (defaults chosen, easy to revisit)

1. **Expo/React Native vs. Flutter** — defaulting to Expo; switch only if a native-module blocker appears.
2. **Gemma 3n vs. Qwen-VL as student** — decide after Phase A data exists; run both through the eval harness, keep the winner.
3. **Cloud fallback in production** — recommended (auto mode), but the app must be fully functional offline for barcode/text paths.
4. **Monetization/distribution** — personal tool first; app-store polish is a Phase 5 question.
