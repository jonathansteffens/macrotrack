# MacroTrack local estimator — model artifacts

## ★ Text-only model (ships now) — `text-v1`

The app is text-only, so the on-device estimator is now a small **text** model:
fine-tuned **Qwen3.5-0.8B** (LoRA), text → FoodClaim JSON. 3.6× smaller and
~2.8× faster on-device than the 3B below, and beats it on every text metric.
See `docs/finetune-text-report.md`; pipeline in `tools/finetune/*text*`.

| File | Size (bytes) | Purpose |
|---|---|---|
| `macrotrack-text-0.8b-q4_k_m.gguf` | 529,296,640 | **deployment** text model (llama.rn) |
| `mt-0.8b-q5_k_m.gguf` | 577,998,080 | quality-max alternative (+49 MB, −7% speed) |
| `mt-2b-q4_k_m.gguf` | 1,274,395,904 | higher-quality fallback (2× slower/bigger) |

```
5777ca4e2abb439d30dbf4e3dceadd421fac0cd0d62e2e4e3443138c1bc8ede0  macrotrack-text-0.8b-q4_k_m.gguf
```

No mmproj (text only). No thinking/reasoning config needed — non-thinking is
baked into the GGUF chat template. Host on release tag `text-v1`.

---

## Vision model (prior, `model-v1`) — kept for history

Fine-tuned **Qwen2.5-VL-3B-Instruct** (QLoRA) for the on-device food
estimator. These are the **exp2** artifacts (vision encoder unfrozen). Produced
by the Phase 3 pipeline in `tools/finetune/` — see `docs/finetune-report.md`
for eval results and `docs/integration-notes.md` for llama.rn wiring. GGUFs are
**not** committed (gitignored); rebuild from `runs/exp2/config.json` or fetch
from the release/HF mirror.

## Files

| File | Size | Purpose |
|---|---|---|
| `macrotrack-estimator-q4_k_m.gguf` | 1.93 GB | **deployment** text model (llama.rn) |
| `mmproj-macrotrack-estimator-f16.gguf` | 1.34 GB | **deployment** vision projector — **fine-tuned** (vision was unfrozen), NOT the stock base projector |
| `macrotrack-estimator-q5_k_m.gguf` | 2.22 GB | higher-quality quant (comparison / higher-RAM phones) |
| `macrotrack-estimator-f16.gguf` | 6.18 GB | full-precision reference (eval only, not shipped) |

Ship the **q4_k_m + mmproj** pair together. Unlike the exp1 build, the mmproj
here is a fine-tuned projector and is **not** interchangeable with the stock
base mmproj — it carries the vision LoRA that drove the photo-accuracy gain.

## SHA-256 (integrity manifest for the app downloader)

```
055d28423732d3e04d0380caa68f398a43ea5e7a556d6a1403bcc8ff72bca0a0  macrotrack-estimator-q4_k_m.gguf
47b8641b1af84c783e34e3aed200482d8b34438f4342f11fd3498f6e5877f442  macrotrack-estimator-q5_k_m.gguf
b58e1796e4c5265fb4a1bb1674441e598af15aad0100c25dffe7452964fb5409  macrotrack-estimator-f16.gguf
c070eb9b5cceeaa401636adb60f7c87ec66fe13b26368e14a9bdff52f2ac5638  mmproj-macrotrack-estimator-f16.gguf
```

## Headline eval (full table in docs/finetune-report.md)

| | untuned | exp1 frozen | **exp2 Q4 (ships)** |
|---|---|---|---|
| text kcal APE, median | 20.3% | 8.1% | **5.6%** (f16 2.2%) |
| text JSON validity | 87% | 100% | **100%** |
| Nutrition5k caloric MAE% | 61.9% | 46.3% | **38.9%** |
| Nutrition5k mass MAE% | 42.7% | 31.0% | **23.1%** |

`base/` holds the untuned Qwen2.5-VL-3B GGUFs used for the baseline.
