# MacroTrack local estimator — model artifacts

Fine-tuned **Qwen2.5-VL-3B-Instruct** (QLoRA) for the on-device food
estimator. These are the **exp2** artifacts (vision encoder unfrozen), which
ship. Produced by the Phase 3 pipeline in `tools/finetune/` — see
`docs/finetune-report.md` for eval results and `docs/integration-notes.md`
for llama.rn wiring. GGUFs are **not** committed (gitignored); rebuild from
`runs/exp2/config.json` or fetch from the release/HF mirror.

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
