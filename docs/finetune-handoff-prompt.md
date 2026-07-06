# Handoff prompt — local estimator fine-tune

Paste everything below the rule into a fresh Claude Code session on the
training workstation, with this repository present. Fill in the two
bracketed values first.

---

You are carrying out Phase 3 of the MacroTrack project: fine-tune a small
vision-language model to replace the cloud estimator in a macro-tracking app,
producing a quantized GGUF deployable on phones via llama.rn. The repository
is at `[REPO_PATH]`. My exported app data (from Settings → Export AI training
data) is at `[AI_EVENTS_PATH]` (may be small or absent — handle both).

## Context you must read first

- `docs/FINETUNE.md` — model/dataset decisions already made; follow them
  unless you find they're no longer true (verify, don't assume).
- `mobile/src/lib/ai/prompt.ts` and `mobile/src/lib/ai/schema.ts` — the
  system prompt and FoodClaim JSON schema. These are FROZEN: the app, the
  synthetic generator, and the eval harness all share them. Train to them
  exactly; do not "improve" them.
- `mobile/src/lib/ai/local.ts` — the 3-stage pipeline your model replaces.
  You are training the full-task variant (one call → complete FoodClaim);
  the per-stage decomposition is a fallback if the full task proves too hard
  for the 3B model.
- `tools/eval/` — the acceptance harness. `run-eval.mjs` currently calls the
  Anthropic API; your first coding task is a small adapter so it can also
  score an OpenAI-compatible local endpoint (llama.cpp `llama-server`).
- `tools/finetune/generate-synthetic.mjs` — text SFT generator with exact
  gold labels. Extend it if you need more meal diversity; keep labels
  DB-derived (never model-guessed).

## Ground rules

1. **Never train on Anthropic model outputs** (violates ToS). Teacher work
   uses open weights: Qwen2.5-VL-72B-Instruct (or the best open VLM you can
   run/rent). The `ai_events` export is fine — the labels there are the
   user's own corrections.
2. Student model: **Qwen2.5-VL-3B-Instruct** (primary), SmolVLM2-2.2B
   (fallback if latency/RAM miss). Before committing, verify llama.cpp still
   supports the chosen architecture's vision path (`docs/multimodal.md` in
   the llama.cpp repo) — this constraint is load-bearing.
3. Everything reproducible: pin seeds, log configs, keep a `runs/` directory
   with one subdirectory per experiment (config + metrics + wandb/tensorboard
   optional). Commit scripts, not checkpoints.
4. Work incrementally with cheap validation at each step; don't launch a
   multi-hour training run whose data pipeline you haven't spot-checked.

## Plan

**0. Environment.** Check GPU (`nvidia-smi`), disk, RAM. Set up a Python env
(uv or conda) with Unsloth (preferred; fall back to LLaMA-Factory or plain
TRL+PEFT if Unsloth lacks vision support for the chosen student), plus
llama.cpp built from source (for conversion, quantization, `llama-server`,
`llama-mtmd-cli`). Node ≥ 22 for the repo's tools.

**1. Baselines before anything else.** Adapt `tools/eval/run-eval.mjs` to
score an arbitrary OpenAI-compatible endpoint. Record three baselines on the
12 text cases: claude-opus-4-8 (if an API key is provided; skip otherwise),
claude-haiku-4-5 (same), and the *untuned* student via llama-server with the
FoodClaim JSON schema as a GBNF grammar. Also expand `tools/eval/cases.jsonl`
to ≥50 cases using the same build-cases mechanism (add specs; ground truth
must come from foods.db) and hold these out of all training data — check for
overlap against the synthetic generator's food pool combinations.

**2. Data.**
- *Synthetic text* (~20–40k): `node tools/finetune/generate-synthetic.mjs
  --n 40000 --seed 1`. Extend the food pools first (aim for 60+ foods,
  restaurant-style items, mixed dishes). Run a `--paraphrase`-style diversity
  pass using your *open* teacher (add a flag or post-process; do not use the
  built-in Anthropic paraphrase path for training data).
- *Nutrition5k*: download from `gs://nutrition5k_dataset` (CC BY 4.0). Use
  overhead RGB frames; build image→FoodClaim examples where grams = measured
  ingredient masses and est_per100 comes from the dataset's per-ingredient
  macros. Respect the official train/test split; the test split is an eval
  set, never training data.
- *Teacher-annotated images* (optional, if budget allows): run the open
  teacher over a Food-101 slice to produce claims; spot-check ≥50 by hand
  before trusting the batch.
- *App corrections*: convert `[AI_EVENTS_PATH]` JSONL into SFT examples
  (conversation turns → final corrected claim). Oversample ×10–20; hold out
  20% as a personal test set.
- Mixture roughly 60% synthetic text / 30% Nutrition5k / 10% corrections+
  teacher data; rebalance based on eval, not vibes.

**3. Train.** QLoRA r=16 (try 32 if underfitting), 4-bit base, lr ~1e-4
cosine, 1–2 epochs, vision encoder frozen first. Target: assistant turn is
the JSON claim only. Validate JSON parse rate on a held-out slice every few
hundred steps. If full-task quality plateaus poorly, fall back to training
the 3-stage decomposition (see local.ts) as three LoRAs or a multi-task mix.

**4. Evaluate against the gates** (from docs/FINETUNE.md): text-case kcal
MAPE within ~10 points of the best recorded cloud baseline; protein MAE
comparable; over-asking ≤ baseline on the unambiguous cases; 100% JSON
validity under grammar; Nutrition5k test-split calorie MAE% reported against
the paper's baselines. Report a small table: untuned student vs tuned student
vs cloud baselines.

**5. Export & smoke-test.** Merge LoRA → convert to GGUF + mmproj with
llama.cpp's conversion scripts → quantize Q4_K_M (also produce Q5_K_M for
comparison). Re-run the eval through `llama-server` on the *quantized* model
— quality drop vs fp16 must be <3 points kcal MAPE. Verify an image request
end-to-end with `llama-mtmd-cli`. Measure tokens/sec; note expected phone
performance is lower.

**6. Deliverables.**
- `models/` (or a HF repo): `macrotrack-estimator-q4_k_m.gguf` + mmproj file.
- `docs/finetune-report.md`: baselines table, data mixture, training config,
  eval results (text cases + Nutrition5k + personal held-out), quantization
  delta, latency measurements, and known failure modes.
- Updated `tools/eval/` with the local-endpoint adapter and expanded cases.
- `docs/integration-notes.md`: exact llama.rn init parameters (model path,
  mmproj, GBNF grammar from the FoodClaim schema, context size, sampling),
  and what to implement in `mobile/src/lib/ai/local.ts` — replace
  `runStage()` with a single llama.rn completion behind the existing
  `localEstimate()` signature. The app side needs an Expo dev build; do not
  attempt to integrate into Expo Go.

Work through steps 0–6 in order, report progress as you go, and stop for my
input only if a hard blocker appears (no GPU, dataset gone, license change).
When done, lead your final report with the baselines-vs-tuned comparison
table.
