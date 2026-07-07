# Handoff — train a small TEXT-ONLY estimator

Paste the block below into a fresh Claude Code session on the training
workstation (fill in the two bracketed paths). This is a smaller, faster
follow-up to the vision fine-tune (`docs/finetune-report.md`): the app went
text-only, so we no longer need a 3B *vision* model — a small text model is
2–6× faster on-device and enough for text → FoodClaim.

---

You are training a **small, text-only** on-device model for MacroTrack, to replace the slow 3B vision model on the (now text-only) estimator path. The repo is at `[REPO_PATH]` — **pull `main` first**. My app-usage export (may be small/empty) is at `[AI_EVENTS_PATH]`.

**Why:** The app dropped its photo/vision path for speed and reliability — it now only takes a text meal description and emits a FoodClaim JSON. The currently-shipped model is a fine-tuned **Qwen2.5-VL-3B** (see `docs/finetune-report.md`). It works, but on a Pixel 7 Pro it decodes in *tens of seconds* — CPU-only, because llama.rn has no usable GPU/NPU backend on that phone (its Android accel is Qualcomm Adreno/Hexagon only; the Pixel is Mali + Google TPU). Since we no longer need vision, we don't need a 3B *vision* model at all. **Goal: train a much smaller text-only model (2–6× faster decode) that stays reliable on text → FoodClaim.**

**Frozen contracts — do not change:** the system prompt (`mobile/src/lib/ai/prompt.ts` → `ESTIMATOR_SYSTEM_PROMPT`) and the JSON schema (`mobile/src/lib/ai/schema.ts` → `FOOD_CLAIM_SCHEMA`). The data generator and eval harness extract these from source; keep them the single source of truth. Train to them exactly.

**Ground rules:** never train on Anthropic model outputs (open teacher only, for paraphrase); reproducible (pin seeds, log configs); validate cheaply at each step before long runs.

**Read first:** `docs/finetune-report.md` (prior run + the merge/export gotchas), `tools/finetune/generate-synthetic.mjs` (text SFT generator), `tools/eval/` (acceptance harness — already has a local-endpoint adapter from the last run).

**Plan:**

0. **Env.** GPU check; Python env (Unsloth, or TRL+PEFT — this is a plain *text* LLM, so no vision collator needed); llama.cpp built (`llama-server`, `llama-quantize`, `llama-cli`); Node ≥ 22.

1. **Baselines.** With `llama-server` + the FoodClaim JSON-schema grammar, record the **currently shipped 3B model's** text scores (median kcal APE, JSON validity, over-asking on `tools/eval/cases.jsonl`) **and its decode tokens/sec** — that's the bar. Cloud rows too if an `ANTHROPIC_API_KEY` is available.

2. **Students (text-only, no vision):** **Qwen2.5-1.5B-Instruct** (primary; best speed/quality balance) and **Qwen2.5-0.5B-Instruct** (max speed). Train both, compare.

3. **Data — text only.** Reuse `generate-synthetic.mjs` (`--n 40000 --seed 1`); extend food pools if helpful; paraphrase-diversity pass with an **open** teacher. Fold in app corrections from `[AI_EVENTS_PATH]` if non-empty (oversample, hold 20% out). **No Nutrition5k, no images.**

4. **Train.** QLoRA (r=16) on the small text model, standard SFT, assistant target = the JSON claim only. Probe JSON validity on a held-out slice during training.

5. **Evaluate & choose.** `run-eval.mjs` against `llama-server` (tuned model + grammar). Compare **1.5B vs 0.5B vs the 3B baseline** on: median kcal APE, protein MAE, JSON validity (want ~100%), item accuracy, DB-match rate, over-asking — **and decode tok/s + estimated on-device latency** (the whole point; target a few seconds per typical claim vs the 3B's tens of seconds). Pick the **smallest** model that stays within a few points of the 3B's median APE at ~100% JSON validity.

6. **Export — text only.** Merge LoRA via `merge_lora.py` (peft `merge_and_unload` into fp16 — NOT `save_pretrained_merged`; see the report's gotcha), convert to GGUF, quantize **Q4_K_M** (also try Q5/Q3 and smaller — measure quality drop < 3 pts, since more speed is the goal). **No mmproj** — it's a text model.

7. **Deliver + hand back the integration values.**
   - Host the chosen GGUF: `gh release create text-v1 <file.gguf> --repo jonathansteffens/macrotrack --title "Text-only model v1"` (repo is public; the app downloads unauthenticated).
   - **Report back exactly three things so the app can be wired:** (a) the release tag/URL, (b) the GGUF **filename**, (c) its **exact byte size** (`stat -c%s <file>`). The app's `mobile/src/lib/ai/local-model.ts` has `MODEL_BASE_URL`, `TEXT_MODEL.name`, and `TEXT_MODEL.sizeBytes` (byte-exact — a mismatch makes the app reject the download). Those are the only three things that change app-side.
   - Write `docs/finetune-text-report.md`: baselines vs tuned, the 1.5B/0.5B/3B comparison (quality **and** tok/s), the chosen model and why, and the quantization delta.

The app is already text-only (no `initMultimodal`, no mmproj), so integration is just updating those three constants + re-upload — the app-side agent handles that once you report filename/size/tag. Work through 0–7 in order, report progress, and stop only on a hard blocker. Lead your final report with the size-vs-speed-vs-quality comparison table.
