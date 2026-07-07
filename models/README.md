# MacroTrack local estimator — model artifacts

Fine-tuned **Qwen2.5-VL-3B-Instruct** (QLoRA) for the on-device food
estimator. Produced by the Phase 3 pipeline in `tools/finetune/` — see
`docs/finetune-report.md` for eval results and `docs/integration-notes.md`
for llama.rn wiring. GGUFs are **not** committed (gitignored); rebuild from
`runs/exp1/config.json` or fetch from the release/HF mirror.

## Files

| File | Size | Purpose |
|---|---|---|
| `macrotrack-estimator-q4_k_m.gguf` | 1.93 GB | **deployment** text model (llama.rn) |
| `mmproj-macrotrack-estimator-f16.gguf` | 1.34 GB | **deployment** vision projector (stock Qwen2.5-VL-3B — vision was frozen) |
| `macrotrack-estimator-q5_k_m.gguf` | 2.22 GB | higher-quality quant (comparison / higher-RAM phones) |
| `macrotrack-estimator-f16.gguf` | 6.18 GB | full-precision reference (eval only, not shipped) |

Ship the **q4_k_m + mmproj** pair together. The mmproj is the unmodified base
projector (the fine-tune froze the vision encoder), so any base Qwen2.5-VL-3B
mmproj of the same precision is interchangeable.

## SHA-256 (integrity manifest for the app downloader)

```
8b6b0c6ff60c1037018866652addb37bc7daa1ee57a35c78a795038a8e6d1cae  macrotrack-estimator-q4_k_m.gguf
88f6d09dd9e14af64075e9db683d48f41c163bf06222173baebed634a0332ec0  macrotrack-estimator-q5_k_m.gguf
467356e89ff1964e4406cfe8f46338e50132bf46c85642baaf0bd8fb699ce1e2  macrotrack-estimator-f16.gguf
b9160fe9d814d1fadf68395677468534778b39ac33c2e7561b7b218626e60d5e  mmproj-macrotrack-estimator-f16.gguf
```

## Headline eval (full table in docs/finetune-report.md)

| | untuned | **tuned Q4 (ships)** |
|---|---|---|
| text kcal APE, median | 20.3% | **8.1%** (f16 2.4%) |
| text JSON validity | 87% | **100%** |
| Nutrition5k caloric MAE% | 61.9% | **46.3%** |

`base/` holds the untuned Qwen2.5-VL-3B GGUFs used for the baseline; the fp16
mmproj there is the source of the deployment projector.
