# Phase 3 fine-tune report — macrotrack-estimator

Fine-tune of **Qwen2.5-VL-3B-Instruct** to replace the cloud estimator,
executed 2026-07-06 on the workstation (2× RTX PRO 6000 Blackwell 96 GB,
shared with a resident sglang server holding ~65 GB per GPU). All scripts,
configs, and eval artifacts are committed; datasets and weights are
reproducible from them (`data/`, `models/`, `runs/*/checkpoints` are
gitignored).

> **Status note:** numbers marked ⏳ are filled in as the corresponding run
> completes; everything else is final.

## Headline comparison

Text cases = `tools/eval/cases.jsonl` (52 cases, ground truth from foods.db,
held out of all training data — verified by `tools/eval/check-overlap.mjs`).

| Model | JSON valid | kcal MAPE | protein MAE | item acc | DB match | over-asking |
|---|---|---|---|---|---|---|
| claude-opus-4-8 (cloud) | — | — | — | — | — | — |
| claude-haiku-4-5 (cloud) | — | — | — | — | — | — |
| Qwen2.5-VL-3B untuned (f16) | 87% | 63.8% | 7.4 g | 100% | 96% | 0% |
| Qwen2.5-VL-3B untuned (Q4_K_M) | 92% | 71.0% | 8.3 g | 98% | 92% | 0% |
| **tuned (f16)** | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| **tuned (Q4_K_M)** | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| tuned (Q5_K_M) | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

**Cloud baselines could not be recorded**: no `ANTHROPIC_API_KEY` was
available in the fine-tune environment (the handoff prompt says to skip in
that case). The FINETUNE.md gate "within ~10 points of the Opus 4.8 kcal
MAPE" therefore cannot be evaluated literally; we report absolute quality and
untuned→tuned deltas instead. Run
`node tools/eval/run-eval.mjs --model claude-opus-4-8 --out runs/baselines/opus.json`
(and `claude-haiku-4-5`) on a machine with a key to complete the table —
cases and harness are deterministic.

On the original 12-case subset (for comparability with any older notes):
untuned f16 scored 37.2% kcal MAPE, protein MAE 8.0 g, 10/12 valid.

### Nutrition5k (photos, official test split, 502 dishes)

| Model | JSON valid | caloric MAE | caloric MAE % | protein MAE | mass MAE % |
|---|---|---|---|---|---|
| paper direct-regression baseline (2103.03375) | — | 70.6 kcal | 26.1% | — | — |
| Qwen2.5-VL-3B untuned (f16) | 85% | 165.0 kcal | 61.9% | 10.2 g | 42.7% |
| **tuned (f16)** | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| **tuned (Q4_K_M)** | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

Human self-report error is ~20–30%; the paper's specialist regressor is
26.1%. A general VLM emitting decomposed, DB-resolvable claims is solving a
harder task than direct calorie regression, so parity with the paper is not
expected — the target is "competitive, and far better than untuned".

## Untuned failure modes (why fine-tuning is needed)

- **Repetition loops**: at temperature 0 the untuned model frequently loops
  inside `db_search_terms` ("bread white white bread white slice …") until
  the 2048-token cap truncates the JSON → 13–15% invalid outputs *even with
  grammar enforcement* (grammar constrains syntax, not termination).
- **Portion mis-anchoring**: kcal MAPE ~64% is dominated by wrong gram
  estimates for household units ("a cup of rice" → 250 g) and whole-item
  weights, exactly what the synthetic data teaches.
- **Never asks**: clarification rate 0% on all cases — including genuinely
  vague ones in real usage; the ask-policy is untrained.
- **Search-term style mismatch**: terms like "grilled chicken breast" match
  the DB worse than USDA-style "chicken breast meat only roasted"; the
  fine-tune teaches the app's actual search ranking.

## Environment

- 2× NVIDIA RTX PRO 6000 Blackwell (96 GB, sm_120), 503 GB RAM, 88 cores.
  ~31 GB VRAM free per GPU (a resident sglang server owns the rest) — this
  constraint shaped the teacher choice (below).
- llama.cpp `bddfd2b` (2026-06-21) rebuilt with CUDA 13.0 into `build-cuda/`
  (`llama-server`, `llama-quantize`, `llama-mtmd-cli`, `llama-cli`),
  `CMAKE_CUDA_ARCHITECTURES=120`. Qwen2.5-VL vision support verified in its
  `docs/multimodal.md` (3B/7B/32B/72B) — the load-bearing llama.rn
  constraint from docs/FINETUNE.md holds.
- Python: `.venv-ft` (uv, Python 3.12) — Unsloth 2026.6.9, torch 2.10.0+cu128
  (sm_120 confirmed), transformers 5.5.0, trl 0.24.0, bitsandbytes.
- Node 22.17.0 (`~/.local/node`).

## Data

| Source | Samples | Labels | Share of train mix |
|---|---|---|---|
| Synthetic text (`generate-synthetic.mjs`, seed 1) | 40,000 generated → 24,000 used | composed from foods.db — exact by construction | ~65% |
| Nutrition5k overhead RGB (official train split) | 2,733 (×4 oversample = 10,932) | measured ingredient masses; est_per100 from dataset macros | ~30% |
| App corrections (`ai_events` export) | **0 — export absent on this machine** | — | 0% |
| Teacher-annotated Food-101 | skipped (see below) | — | 0% |

- **Generator extensions**: food pools 36 → 79 items (restaurant items,
  drinks, snacks, more proteins/starches), 14 composed mixed dishes
  (burritos, sandwiches, stir-fry, spaghetti, salads…) that appear as one
  phrase in the text and decomposed items in the claim; 13% of samples carry
  a gold clarifying question; grammar-correct count/measure rendering.
- **Paraphrase diversity pass**: 50% of the 40k texts rewritten by the open
  teacher (below) at temperature 0.9, with a fidelity prompt + length guard;
  spot-checks confirmed quantities/foods preserved. The built-in Anthropic
  paraphrase path was **not** used for training data (ToS).
- **Teacher = Qwen2.5-VL-32B-Instruct (Q4_K_M, llama-server)**, not the 72B
  named in FINETUNE.md: with ~31 GB free per GPU the 47 GB 72B Q4 requires
  both GPUs and would have serialized against training and risked OOM next
  to the resident sglang server; 32B fits on one GPU. It is "the best open
  VLM this box can actually run" for the only teacher task that remained
  (text paraphrasing) after Food-101 annotation was cut.
- **Food-101 teacher annotation skipped**: optional per the plan; with no
  app corrections to mix in and Nutrition5k providing real measured photo
  labels, the marginal value didn't justify the added teacher hours + manual
  spot-check requirement in this run. Revisit if photo eval misses the gate.
- **Eval hold-out enforced at the source**: both generators skip any meal
  whose resolved DB-food set equals an eval-case combo (5,159 collisions
  skipped in the 40k text run; 10 watermelon-only dishes dropped from the
  N5k train split), and `check-overlap.mjs` verifies the final files:
  42,733 samples, 0 overlaps.

## Training

Config: `runs/exp1/config.json` (committed); script
`tools/finetune/train_qlora.py` (Unsloth `FastVisionModel`).

- QLoRA r=16, α=16, dropout 0, on language attention+MLP; **vision encoder
  frozen**; base loaded 4-bit; seed 1.
- lr 1e-4 cosine, warmup 3%, 1 epoch, effective batch 16 (4 × grad-accum 4),
  bf16, adamw_8bit, max_length 4096.
- Assistant-only labels via Unsloth's vision collator (train-on-responses).
- JSON-validity probe on a held-out slice every 300 steps (24 prompts,
  greedy, no grammar): dry-run went 0/7 → 7/7 by step 40; full-run probes ⏳.

Dry run (`runs/dryrun/`, 352 samples): validated the full pipeline —
mixed text+image batches, masking, merged-fp16 save, GGUF export, quantize,
`llama-mtmd-cli` image round-trip — before the multi-hour run (ground rule 4).

## Quantization delta

| Variant | Size | kcal MAPE (52 cases) | Δ vs f16 |
|---|---|---|---|
| tuned f16 | ~6.2 GB | ⏳ | — |
| tuned Q5_K_M | ~2.2 GB | ⏳ | ⏳ |
| tuned Q4_K_M | ~1.9 GB | ⏳ | ⏳ (gate: <3 pts) |

## Latency

⏳ llama-server tokens/sec on this GPU; phone expectations in
docs/integration-notes.md.

## Known failure modes (tuned model)

⏳ filled after eval review.

## Reproduction

```bash
# data
bash tools/finetune/fetch-nutrition5k.sh
node tools/finetune/convert-nutrition5k.mjs
node tools/finetune/generate-synthetic.mjs --n 40000 --seed 1 \
  --paraphrase-url http://127.0.0.1:8034/v1 --paraphrase-frac 0.5 \
  --out data/sft/sft-text.jsonl        # teacher: Qwen2.5-VL-32B on :8034
node tools/eval/check-overlap.mjs data/sft/sft-text.jsonl data/nutrition5k/n5k-train.jsonl

# train + export
.venv-ft/bin/python tools/finetune/train_qlora.py --config runs/exp1/config.json
bash tools/finetune/export-gguf.sh runs/exp1/merged macrotrack-estimator

# evaluate (llama-server on :8033 with the artifact under test)
node tools/eval/run-eval.mjs --base-url http://127.0.0.1:8033/v1 --model <name> --out runs/<x>.json
node tools/eval/run-eval-n5k.mjs --base-url http://127.0.0.1:8033/v1 --out runs/<x>-n5k.json
```
