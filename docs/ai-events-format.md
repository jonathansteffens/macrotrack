# ai_events export format — the correction flywheel

The app's per-food correction memory doubles as **training data** for the next
estimator fine-tune. Every time the user edits an AI claim before saving (bumps
grams, deletes a hallucinated item, adds a missed one, re-files the meal), that
correction is a gold sample: *what the model said* vs *what the user meant*.
Two training rounds have run with this export absent — this contract makes the
loop real.

## File

One JSONL file, exported from settings (alongside/inside the backup is fine, but
the AI-events export must also be available standalone — it's what gets copied
to the training workstation). Filename convention: `ai-events-YYYYMMDD.jsonl`.

## Row schema (one JSON object per line)

```jsonc
{
  "v": 1,                         // format version
  "ts": "2026-07-08T18:22:31Z",   // when the estimate happened (ISO 8601, UTC)
  "model": "text-v1",             // release tag of the local model that produced the claim
  "user_text": "two soft tacos and a coke",   // exactly what the user typed (required)
  "model_claim": { /* FoodClaim as emitted, unmodified */ },
  "final_claim": { /* FoodClaim-shaped: items as actually saved after user edits */ },
  "edits": [                      // machine-readable summary (derivable, but explicit is robust)
    { "kind": "grams",  "item": "soft taco", "from": 200, "to": 156 },
    { "kind": "add",    "item": "coca cola" },
    { "kind": "remove", "item": "mayonnaise" },
    { "kind": "meal",   "from": "snack", "to": "lunch" }
  ],
  "clarification": {              // present only if the model asked and user answered
    "questions": ["…"], "answer_text": "…"
  }
}
```

Rules:
- **Log only estimator interactions the user saved** (confirmed into the log).
  Abandoned estimates are noise; skip them.
- `final_claim` items use the same shape as FoodClaim items where possible
  (name, grams, db_search_terms if known from the resolved food, est_per100
  optional). If the user swapped the DB match, put the chosen food's canonical
  DB name in `db_search_terms[0]`.
- Rows where the user saved with **zero edits** are also valuable (positive
  examples) — include them with `"edits": []`. They confirm the model was right.
- No PII beyond the meal text itself; timestamps UTC.

## How training consumes it (workstation side)

`(user_text → final_claim)` becomes an SFT sample in the exact format of
`generate-synthetic.mjs` output (system prompt injected at train time). Rows
with edits are **oversampled** (they encode the model's real failure modes);
zero-edit rows are sampled at ~1× as regularization. 20% of correction rows are
held out as an eval slice (`corrections-heldout.jsonl`) to measure whether the
next fine-tune actually fixed what users fixed. Per-food gram corrections
(`kind:"grams"`) additionally feed a per-food portion-prior table that can be
compared against the synthetic generator's unit table — if users consistently
bump "rice, 1 cup" 160→210 g, the generator's anchor gets updated too.

## App-side notes

- The correction-memory table the app keeps for UX ("you usually make this 210 g")
  and this export should be views over the same underlying rows — don't build two
  pipelines.
- Cap the export at the last ~5,000 events; older rows have diminishing value.
