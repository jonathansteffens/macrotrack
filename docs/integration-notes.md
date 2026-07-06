# Integrating the fine-tuned local estimator (llama.rn)

How to wire `models/macrotrack-estimator-q4_k_m.gguf` into the app's local
engine slot. The app side requires an **Expo dev build** (llama.rn is a
native module — it will not load in Expo Go). Bundle with the first EAS build.

## Files to ship

| File | Size | Purpose |
|---|---|---|
| `macrotrack-estimator-q4_k_m.gguf` | ~1.9 GB | fine-tuned Qwen2.5-VL-3B text model, Q4_K_M |
| `mmproj-macrotrack-estimator-f16.gguf` | ~1.3 GB | vision projector (f16 — small, quality-critical) |

Download on first use into `FileSystem.documentDirectory` (they exceed OTA
asset limits); verify with a SHA-256 manifest.

## Initialization

```ts
import { initLlama } from 'llama.rn';

const context = await initLlama({
  model: `${documentDirectory}models/macrotrack-estimator-q4_k_m.gguf`,
  n_ctx: 4096,          // system (~600 tok) + image (~1.3k tok) + claim fits comfortably
  n_gpu_layers: 99,     // Metal on iOS / OpenCL-Hexagon on Android; falls back to CPU
  use_mlock: false,     // let the OS page under memory pressure
});
await context.initMultimodal({
  path: `${documentDirectory}models/mmproj-macrotrack-estimator-f16.gguf`,
  use_gpu: true,
});
```

Load lazily on first AI request and call `context.release()` when the app
backgrounds — the ~2.5 GB working set must not sit in memory on iOS.

## Per-request parameters

```ts
const res = await context.completion({
  messages,                      // see below
  response_format: {
    type: 'json_schema',
    json_schema: { strict: true, schema: FOOD_CLAIM_SCHEMA },  // from ai/schema.ts
  },
  temperature: 0,                // deterministic; the model was trained for one right answer
  n_predict: 1024,               // a 6-item claim is ~500 tokens; 1024 is a safe ceiling
});
const claim = sanitizeClaim(JSON.parse(res.text));
```

- `response_format json_schema` compiles the schema to a GBNF grammar inside
  llama.cpp — the same mechanism `tools/eval/run-eval.mjs` exercises against
  llama-server, so eval and app behavior match. (A pre-generated grammar is
  checked in at `docs/foodclaim.gbnf` if you prefer passing `grammar:`
  directly; regenerate with llama.cpp's `examples/json_schema_to_grammar.py`
  whenever schema.ts changes.)
- Keep `temperature: 0`. Untuned models loop inside `db_search_terms` at
  temperature 0 until they hit the token cap (observed in baselines); the
  fine-tune eliminates this, but if you ever swap in a different base model,
  set `n_predict` and check for `truncated` in the result.

## Message shape (replaces the 3-stage pipeline)

`localEstimate()` in `mobile/src/lib/ai/local.ts` keeps its signature; the
three `runStage()` calls collapse into ONE completion:

```ts
const messages = [
  { role: 'system', content: ESTIMATOR_SYSTEM_PROMPT },     // from ai/prompt.ts, byte-identical
  ...turns.map((t) =>
    t.role === 'assistant'
      ? { role: 'assistant', content: JSON.stringify(t.claim) }
      : {
          role: 'user',
          content: [
            ...(t.input.imageBase64
              ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${t.input.imageBase64}` } }]
              : []),
            { type: 'text', text: t.input.text?.trim() || 'Estimate the nutrition of this meal.' },
          ],
        }
  ),
];
```

This mirrors `cloudEstimate()` in `estimator.ts` (multi-turn clarification
included — the model was trained to re-emit the complete claim after answers)
and matches the training format exactly: system prompt from `prompt.ts`,
photo-only default text `'Estimate the nutrition of this meal.'`, assistant
turns are bare JSON claims.

Keep `sanitizeClaim()` and the existing resolver untouched — the model's
`db_search_terms` are trained against the app's actual search ranking over
`foods.db`.

## Image handling

- Downscale photos to ≤768 px long side before base64 — Qwen2.5-VL image
  token count grows with resolution; 768 px keeps the vision pass ~1.3k
  tokens and matches the Nutrition5k training distribution (640×480).
- JPEG quality 85 is fine; the model was trained on PNG and JPEG both after
  the resize pass.

## Performance expectations

Measured on RTX PRO 6000 (workstation, llama-server, Q4_K_M): see
`docs/finetune-report.md` §Latency. Phone throughput is far lower — expect
roughly 15–25 tok/s decode on a 2024-class mid-range Android (Snapdragon 8s
Gen 3-ish) ⇒ ~25–35 s for a worst-case 500-token claim, under the 8 s target
only for short claims. If photo-to-claim latency misses the <8 s Phase 3 exit
criterion on real hardware:

1. drop to `SmolVLM2-2.2B` (fallback per docs/FINETUNE.md), or
2. shrink the emitted claim (fewer `db_search_terms` per item — retrain with
   1 term), or
3. keep cloud-auto mode as default for photos and local for text.

## Settings toggle

`engine.ts` already picks cloud vs local; add `'local-gguf'` alongside the
Haiku stand-in so both can be A/B'd during rollout, then retire the stand-in.
