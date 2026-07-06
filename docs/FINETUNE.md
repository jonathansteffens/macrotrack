# Local model fine-tune — research & plan

Research findings (July 2026) for replacing the Haiku stand-in pipeline with
an on-device model. The agent prompt that executes this lives in
[finetune-handoff-prompt.md](finetune-handoff-prompt.md).

## Deployment target decides the model

The app's local engine slot ([mobile/src/lib/ai/local.ts](../mobile/src/lib/ai/local.ts))
will be backed by **llama.rn** (React Native bindings for llama.cpp):

- Multimodal supported: mmproj projector files + **base64 image input** —
  which is exactly what the app already produces (`EstimateInput.imageBase64`).
- **Grammar sampling (GBNF / JSON schema)** — replaces the cloud structured
  outputs guarantee, so the FoodClaim schema keeps working verbatim.
- GGUF only; GPU accel (Metal on iOS, Hexagon NPU on Android).
- Requires an Expo **dev build** (not Expo Go) — bundle with the first EAS build.

llama.cpp's multimodal stack (libmtmd) supports **Qwen2.5-VL (3B+)**,
**SmolVLM/SmolVLM2 (256M–2.2B)**, Gemma 3 (4B+), Pixtral, Qwen2-VL. It does
**not** support Gemma 3n's vision encoder (MobileNet-V5) — Gemma 3n vision
runs via Google AI Edge / LiteRT instead, a completely different runtime.

## Student model

| Candidate | Size (Q4) | Why / why not |
|---|---|---|
| **Qwen2.5-VL-3B-Instruct** ← primary | ~2.0 GB + mmproj | Strongest small VLM with confirmed llama.cpp vision support; first-class Unsloth/LLaMA-Factory fine-tuning. License: Qwen Research License (fine for personal use; revisit if the app is ever distributed commercially). |
| **SmolVLM2-2.2B-Instruct** ← fallback | ~1.4 GB | Apache 2.0, llama.cpp-supported, faster on mid-range phones; noticeably weaker perception — try if 3B is too slow. |
| Gemma 3n E2B/E4B | ~1.5–3 GB | Purpose-built for on-device, but vision only runs under LiteRT/MediaPipe — would mean abandoning llama.rn and writing a second native integration. Keep as plan C. |

## Teacher model

**Qwen2.5-VL-72B-Instruct** (open weights) for anything a teacher is needed
for: annotating food photos with structured claims, paraphrase diversity at
scale, and clarification-dialogue synthesis. Do **not** distill from Claude
API outputs — training competing models on outputs violates Anthropic's ToS.
(The in-app Haiku/Opus engines are product features, not training sources;
the `ai_events` export contains the *user's* corrections, which are yours.)

## Datasets

| Source | What it gives | License / access |
|---|---|---|
| **Nutrition5k** (Google Research) | ~5k real cafeteria dishes: RGB-D images + videos, per-dish **measured mass, calories, macros, ingredient lists** (USDA-derived). The gold standard for photo portion estimation. | CC BY 4.0 · `gs://nutrition5k_dataset` ([repo](https://github.com/google-research-datasets/Nutrition5k)) |
| **Synthetic text SFT** — [tools/finetune/generate-synthetic.mjs](../tools/finetune/generate-synthetic.mjs) | Unlimited text-entry examples with **exact gold labels by construction** (meals composed from foods.db; grams, per-100g macros, USDA search terms all known). ~15% carry gold clarifying questions. `--paraphrase` adds phrasing diversity. | Generated locally |
| **App corrections** — Settings → "Export AI training data" | (conversation, user's final logged items) pairs from real usage. Small but distribution-matched — weight heavily, hold some out as a personal test set. | Yours |
| Food-101 / FoodX-251 | Classification breadth (101–251 food categories) for identify-stage robustness; teacher-annotate into claim format. | Research licenses |

## Training recipe (summary — full detail in the handoff prompt)

- **QLoRA** (r=16–32) via **Unsloth** (or LLaMA-Factory), 4-bit base.
- Chat format identical to the app: the system prompt from
  [prompt.ts](../mobile/src/lib/ai/prompt.ts) + user text/image → assistant
  emits FoodClaim JSON ([schema.ts](../mobile/src/lib/ai/schema.ts)). The
  generator and eval both extract prompt/schema from the app source, so
  nothing can drift.
- Mixture: synthetic text (bulk) + Nutrition5k-derived image examples +
  app corrections (oversampled) + teacher-annotated Food-101 slice.
- Eval gates before shipping: [tools/eval/run-eval.mjs](../tools/eval/run-eval.mjs)
  scores any OpenAI-compatible endpoint (llama.cpp `llama-server` works) on
  kcal MAPE, protein MAE, item accuracy, DB match rate, over-asking rate;
  plus a Nutrition5k held-out split for photos.
- Export: merge LoRA → convert to GGUF + mmproj → quantize **Q4_K_M** →
  verify with `llama-mtmd-cli` → hand off to the app (replace `runStage()`
  in local.ts with llama.rn inference; grammar-constrain with the FoodClaim
  schema).

## Success criteria (from PLAN.md Phase 3)

- Text cases: within ~10 percentage points of the Opus 4.8 baseline on kcal
  MAPE; JSON validity 100% (grammar-enforced).
- Nutrition5k held-out: calorie MAE% competitive with published baselines
  (~20–30% is the human self-report error to beat).
- Over-asking rate ≤ cloud baseline on unambiguous cases.
- On-device: < 8 s photo-to-claim on a mid-range Android; < 3 GB RAM.

Sources: [llama.rn](https://github.com/mybigday/llama.rn) ·
[llama.cpp multimodal docs](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md) ·
[Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) ·
[Nutrition5k paper](https://arxiv.org/pdf/2103.03375) ·
[small-VLM survey](https://arxiv.org/pdf/2510.13890)
