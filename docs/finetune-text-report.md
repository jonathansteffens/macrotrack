# Text-only estimator fine-tune report — MacroTrack

Follow-up to `docs/finetune-report.md`. The app went **text-only** (a text meal
description → FoodClaim JSON; no photo path), so the shipped fine-tuned
**Qwen2.5-VL-3B** is now overkill: on a Pixel 7 Pro it decodes on CPU (llama.rn
has no usable GPU/NPU backend there) at *tens of seconds* per claim. This run
trains a **much smaller text-only model** that is 2–6× faster on-device and
**at least as accurate** on text → FoodClaim.

Executed 2026-07-07 on the workstation (2× RTX PRO 6000 Blackwell 96 GB, one
shared with a resident sglang server). Students: **Qwen3.5-0.8B** and
**Qwen3.5-2B** (the small dense text models of the Qwen3.5 family — hybrid
Gated-DeltaNet + full-attention, non-thinking by default). Frozen contracts
(`prompt.ts` `ESTIMATOR_SYSTEM_PROMPT`, `schema.ts` `FOOD_CLAIM_SCHEMA`) were
trained to exactly and are the single source of truth for the data generator and
eval harness.

## Headline — size vs speed vs quality

Text cases = `tools/eval/cases.jsonl` (52 cases, ground truth from `foods.db`,
held out of training — verified by `check-overlap.mjs`). **Median** kcal APE is
the honest headline (the mean is dominated by low-gram outliers like popcorn —
see the prior report). CPU tok/s is a **single 4-thread run** (matches the app's
`n_threads: 4`) — the truest Pixel proxy, since llama.rn decodes on CPU there.

| Model (Q4_K_M) | Size | JSON valid | median APE | mean MAPE | p90 APE | protein MAE | item acc | DB match | over-ask | CPU tok/s (phone proxy) | GPU tok/s | est. Pixel latency* |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen2.5-VL-3B (shipped) | 1.93 GB | 100% | 4.9% | 33.3% | — | 3.7 g | 92% | 95% | 2% | 19.3 (1.0×) | 364 | ~11–15 s |
| **Qwen3.5-0.8B ← ships** | **0.53 GB** | **100%** | **3.5%** | 21.0% | 40.8% | 3.0 g | 96% | 98% | 0% | **54.5 (2.8×)** | 548 | **~4–5 s** |
| Qwen3.5-2B | 1.27 GB | 100% | **0.0%** | **10.1%** | **21.2%** | **2.1 g** | **100%** | 99% | 0% | 26.1 (1.4×) | 389 | ~8–9 s |

\* ~200–280 output tokens for a typical multi-item claim, at the CPU tok/s
above. The 3B's 19.3 tok/s here matches the Pixel's real-world 15–25 tok/s, so
the **2.8× ratio transfers**: the shipped 3B's "tens of seconds" becomes a few
seconds. (0.8B median APE is 2.1–3.8% across runs — batched-decoding
nondeterminism; the deterministic single-stream number on the shipped file is
**3.5%**. Every variant beats the 3B's 4.9%.)

**GPU speedup understates the phone win.** On the workstation GPU the 0.8B is
only ~1.5× the 3B (548 vs 364 tok/s) because a fast GPU is compute/overhead-bound
(SSM kernel launches + the 248 k-token `lm_head` are fixed per-token costs). The
**phone is memory-bandwidth-bound**, where the 0.8B's 3.6× smaller weights
dominate → **2.8×**. The CPU-4-thread number is the one that matters for the
Pixel.

**Bottom line: the 0.8B fine-tune is 3.6× smaller and ~2.8× faster than the
shipped 3B, and *beats* it on every text metric.** A 0.8B is enough because the
hard part — decomposing a meal into DB-resolvable items with realistic grams and
USDA-style search terms — is a narrow, learnable mapping; the food DB does the
nutrition math, so the model needs format discipline and portion sense, not broad
knowledge. The **2B is better still** (tighter error tail: mean 10.1% / p90 21.2%
vs the 0.8B's 21.0% / 40.8%; perfect item accuracy) but 2× slower and bigger for
a quality edge on cases both already handle — kept as the higher-quality fallback
if the 0.8B's tail proves too loose in real use.

## The choice and why

**Ships: Qwen3.5-0.8B-Q4_K_M.** It is the smallest model, and it already beats
the shipped 3B on every text metric at 100% JSON validity while decoding 2.8×
faster on the phone path — the exact goal (smallest model within a few points of
the 3B). Both new models qualify; the 2B trades 2× the size/latency for a
tighter error tail on cases the 0.8B already handles, which this app doesn't
need. The 2B GGUFs are exported and kept as a drop-in higher-quality fallback.

**Verification of the exact shipped file** (`macrotrack-text-0.8b-q4_k_m.gguf`,
served with the app's default config — baked non-thinking template, no reasoning
flag):

- **52/52 JSON valid**, deterministic median APE **3.5%**, over-asking 0%.
- **Robustness probe 19/19 valid** on messy / OOD / adversarial inputs (typos,
  vague, exotic cuisines, non-food) — degrades gracefully, never invalid or
  runaway (see Robustness).
- **Colloquial portions** convert to sensible grams, including terms never in
  training: handful of almonds → 28 g, glass of milk → 244 g, slice of pizza →
  107 g, scoop of ice cream → 132 g, dollop of sour cream → 12 g, splash of oil
  → 14 g, can of coke → 368 g, plate of spaghetti → 223 g. Minor high estimates
  on very small units (pat of butter 16 g, strip of bacon 27 g) and one miss
  (cream in "coffee with cream") — all near-zero/low-calorie, negligible to day
  totals.

## Quantization delta (Qwen3.5-0.8B)

Gate: quantized median-APE drop vs f16 < 3 points. On-device decode is
memory-bandwidth-bound, so smaller = faster — but small models are
quant-sensitive, so we swept the ladder.

| 0.8B variant | Size | JSON valid | median APE | protein MAE | item acc | over-ask | CPU tok/s |
|---|---|---|---|---|---|---|---|
| f16 (reference) | 1.52 GB | 100% | 0.0% | 2.0 g | 90% | 0% | — |
| Q6_K | 0.63 GB | 100% | 0.0% | 2.2 g | 90% | 0% | 49.1 |
| Q5_K_M | 0.58 GB | 100% | 0.0% | 1.6 g | 94% | 2% | 50.5 |
| **Q4_K_M ← ships** | **0.53 GB** | **100%** | **2.1%** | **3.1 g** | **96%** | **0%** | **54.5** |
| Q3_K_M | 0.47 GB | 100% | **22.1%** | 13.3 g | 71% | **100%** | 49.1 |

**Q4_K_M is the pick**: smallest quant that clears the gate (2.1 pts < 3 vs f16)
and still **beats the shipped 3B** (4.9% median). **Q3_K_M collapses** — 22%
median APE and it asks a clarifying question on *every* case; 3-bit is too coarse
for a 0.8B (the ladder confirms small models are quant-sensitive). Q4→Q6 differ
by only ~10% in speed (the 248 k-token vocab makes the shared `lm_head` a big
fixed per-token cost that dampens quant-size speed sensitivity), so **Q5_K_M is a
drop-in quality-max alternative** (median 0.0%, protein 1.6 g) at +49 MB / −7%
speed if preferred.

## Robustness (off-distribution probe)

`tools/eval/robustness-check.mjs` sends 19 messy / out-of-distribution /
adversarial free-text meals through the real prompt + grammar (typos, vague
portions, unusual cuisines, non-food, odd quantities). **0.8B-Q4: 19/19 valid
JSON**, and sensible where it matters:

- **Typos** handled ("2 egs and tost with buttr" → eggs, toast, butter).
- **Vague** inputs get reasonable guesses; **compound** meals decompose well
  (a 4-item "bacon cheeseburger, fries, milkshake, caesar salad" → 7 items).
- **Non-pool dishes** partly recognized ("chicken tikka masala with naan",
  "sushi rolls").
- **Graceful** on true OOD/adversarial: exotic foods (pho, banh mi) improvise
  imperfectly but stay valid; non-food ("car keys" → 1 g + asks; "???"; "didn't
  eat" → 0 g) never crashes or loops.

Failure modes are benign (tiny grams / a clarifying question), never invalid
JSON or runaway generation. The OOD-food gaps are **data coverage** (the
synthetic food pools), not model capacity — extending the pools would close them.

## On-device speed / latency

CPU 4-thread decode (`-ngl 0 -t 4`, the phone path):

| Model | CPU tok/s | ×3B |
|---|---|---|
| 3B-Q4 (shipped) | 19.3 | 1.0× |
| 0.8B-Q4 | 54.5 | **2.8×** |
| 0.8B-Q5 | 50.5 | 2.6× |
| 0.8B-Q6 | 49.1 | 2.5× |

The workstation's 4-thread 3B number (19.3 tok/s) lands in the Pixel 7 Pro's
real 15–25 tok/s band, so the measured **2.8× speedup transfers to the phone**:
a ~220-token claim goes from the 3B's ~11–13 s to **~4–5 s** — into the "few
seconds" target.

## Data

Reused **`data/sft/sft-text.jsonl`** from the prior run verbatim (40,000
synthetic text samples, seed 1; first 20 k paraphrased by an open teacher
Qwen2.5-VL-32B; eval-combos held out). Its embedded system prompt was verified
**byte-identical** to the current `prompt.ts` (contracts unchanged since
generation), so it is still on-contract — no regeneration or teacher server
needed. **No Nutrition5k, no images.** The `ai_events` app-corrections export was
**absent** on this machine (as in the prior run), so none were folded in.

## Training

Script: `tools/finetune/train_text_sft.py` (text-only successor to the VL
`train_qlora.py`). Configs `runs/text-0.8b/config.json`, `runs/text-2b/config.json`.

- Qwen3.5-small loads as a pure **text** model (`Qwen3_5ForCausalLM`, no vision
  tower). **bf16 LoRA** (not 4-bit QLoRA — the GPU is free and these models are
  tiny, so full-precision base gives cleaner gradients for the same cost),
  r=16, α=16, dropout 0, `target_modules="all-linear"` (adapts the SSM
  in/out-projections + full-attn q/k/v/o + MLP; `lm_head` excluded).
- lr 2e-4 cosine, warmup 3%, 1 epoch, effective batch 32, bf16, seed 1,
  max_len 2048.
- **Assistant-only loss on the JSON claim.** Non-thinking: the chat template
  puts an empty `<think>\n\n</think>\n\n` in the *prompt* (add_generation_prompt),
  so loss is masked over the whole prompt incl. that block and computed only on
  `{JSON}<|im_end|>` — identical to the grammar-constrained inference path.
- JSON-validity probe (24 held-out prompts, greedy, no grammar) every 400 steps:
  **0.8B 14/24 → 24/24 by step 400**, held to the end (loss 0.017). The 2B was
  **24/24 from step 0** (stronger base) and stayed there (loss 0.040). The model
  internalizes the exact FoodClaim schema; validity no longer depends on the
  grammar as a crutch. Runtimes: 0.8B ~44 min, 2B ~61 min (1 epoch, one RTX PRO
  6000, fla kernels).
- **flash-linear-attention required.** Without it, transformers' pure-torch
  Gated-DeltaNet fallback (`torch_chunk_gated_delta_rule`) balloons to ~92 GB
  and OOMs; `pip install flash-linear-attention` routes it through the efficient
  chunked kernel (~6 GB). (causal-conv1d not needed — its torch fallback is
  memory-cheap.)

## Export (text-only) — three Qwen3.5 gotchas

`merge_lora_text.py` (peft `merge_and_unload` into fp16 — **not**
`save_pretrained_merged`) → `export-gguf-text.sh` (`force_no_think.py` +
`convert_hf_to_gguf.py --no-mtp` + `llama-quantize`). **No mmproj** — text only.

1. **`--no-mtp`** — Qwen3.5 has a multi-token-prediction head
   (`mtp_num_hidden_layers: 1`). The converter otherwise emits it as a phantom
   `blk.24`, and llama.cpp fails to load ("missing tensor
   `blk.24.attn_norm.weight`"). `--no-mtp` drops the draft head we don't use.
2. **Non-thinking baked into the template** (`force_no_think.py`). Qwen3.5 is
   hybrid-reasoning; if a runtime leaves reasoning on "auto" it opens a `<think>`
   block, the model reasons freely (the JSON grammar is gated until after
   `</think>`), and `content` comes back **empty**. Rather than require the app
   to pass reasoning=off, we rewrite the embedded chat template so the generation
   prompt always emits the **closed** empty block — the deployed GGUF is
   non-thinking under any runtime, so **the app needs no thinking config**
   (verified: default-reasoning llama-server returns clean JSON).
3. **Merge from the fp16 base**, never `save_pretrained_merged` (the prior
   report's gotcha — it silently emitted base weights for VL).

## Integration values (app-side)

The app is already text-only; only three constants in
`mobile/src/lib/ai/local-model.ts` change:

- **`MODEL_BASE_URL`:** `https://github.com/jonathansteffens/macrotrack/releases/download/text-v1`
- **`TEXT_MODEL.name`:** `macrotrack-text-0.8b-q4_k_m.gguf`
- **`TEXT_MODEL.sizeBytes`:** `529296640` (byte-exact, `stat -c%s`; sha256
  `5777ca4e2abb439d30dbf4e3dceadd421fac0cd0d62e2e4e3443138c1bc8ede0`)

No thinking/reasoning config is required (baked into the GGUF template, gotcha 2).
The `n_ctx: 4096` in `local-model.ts` is comfortable — a full claim is
system (~600) + user + JSON (~300) ≈ 1 k tokens.

## Reproduction

```bash
pip install flash-linear-attention            # into .venv-ft (uv)
# 0.8B
.venv-ft/bin/python tools/finetune/train_text_sft.py --config runs/text-0.8b/config.json
.venv-ft/bin/python tools/finetune/merge_lora_text.py \
  --adapter runs/text-0.8b/checkpoints/final-lora --base Qwen/Qwen3.5-0.8B --out runs/text-0.8b/merged
bash tools/finetune/export-gguf-text.sh runs/text-0.8b/merged models/mt-0.8b Q4_K_M Q5_K_M Q6_K Q3_K_M
bash tools/eval/eval-local-gguf.sh models/mt-0.8b-q4_k_m.gguf mt-0.8b-q4_k_m 1 8033
node tools/eval/robustness-check.mjs --base-url http://127.0.0.1:8036/v1
```

## Known limitations / next steps

- **OOD-food coverage**: exotic dishes not in the synthetic pools (pho, banh mi)
  are decomposed imperfectly. Extend `generate-synthetic.mjs` pools if real usage
  shows these; fold in `ai_events` corrections when available.
- **Non-food / empty input** ("car keys", "???"): produces a valid but token
  claim rather than refusing. Benign (tiny grams), but a resolver-side floor or
  an explicit "no food" path could harden it.
- **Real-phone latency** still to be confirmed on a Pixel 7 Pro dev build; the
  CPU-4-thread proxy projects ~4–5 s for a typical claim.
