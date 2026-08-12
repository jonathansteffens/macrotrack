# Quantity hybrid: taking the arithmetic away from the model

**Status: implemented, gate-verified, not yet released.** Ships as a resolver
change; no new model is required (it improves v8, v9 and v10 alike).

## The problem

The estimator does five jobs at once:

| Job | Needs a model? | How it measures |
|---|---|---|
| Segment the text into items | yes | item accuracy 95–98% |
| Name each food / pick DB terms | mostly | DB match 97% |
| Infer unstated portions ("a burger" → 170 g) | **yes — world knowledge** | — |
| Macros for foods the DB lacks (`est_per100`) | **yes** | — |
| **Parse how much, and multiply** | **no — arithmetic** | **every quantity failure** |

Three rounds of data work (v8 → v9 → v10) moved the gate's quantity score
71.4% → 80.4% → 82.1%, but never cleared the ≤5% catastrophic bar, and each
round broke cases the previous one had right. Inspecting the failures showed why:
they were not knowledge errors.

```
"half a dozen bagels"              -> count 12    the idiom is 6
"a half pound turkey burger patty" -> count 0.5   a weight read as a count
"20 chicken nuggets"               -> count null  the count dropped entirely
"a pound of ground beef"           -> 182 g       1 lb is 454 g, exactly
"a quarter of the lasagna"         -> 36 g        fraction applied to a serving
"5 chicken mcnuggets"              -> 555 g       5 x a whole 111 g serving
```

Schema v2 had already moved the *multiplication* into code ("the model copies
counts, code multiplies"), which fixed the "10 tacos → 1 taco" class outright.
This is the same move one step earlier: take the *parse* too.

## What was measured

`tools/eval/quantity-sim.mjs` replays saved gate results under several
architectures, scoring with the gate's own classifier. No GPU, no retrain — the
model's output is already on disk, so each lever's ceiling is measurable before
paying for a training round. Over the 58 band cases (within-tolerance /
catastrophic):

| Architecture | v8 | v9 | v10 |
|---|---|---|---|
| model alone (before) | 70.7% / 5.2% | 79.3% / 6.9% | 81.0% / 5.2% |
| + DB `portions_json` units | 63.8% / 15.5% | 65.5% / 15.5% | 70.7% / 12.1% |
| + grammar only | 75.9% / 6.9% | 87.9% / 5.2% | 84.5% / 5.2% |
| **+ grammar + curated table** | **89.7% / 1.7%** | **93.1% / 1.7%** | **91.4% / 0.0%** |

Then confirmed end-to-end by re-running the real 151-case gate against v10 with
the override wired in:

```
quantity     53/56  (94.6%)      was 46/56 (82.1%)
catastrophic  0/58   (0.0%)      was  3/58  (5.4%)   [bar ~5%]
regression   74/80  (92.5%)      was 75/80 (93.8%)   see below
```

Eight quantity cases fixed, including all three catastrophics, none made worse.
Reproduced on two independent gate runs.

The regression category reads one case lower, and it is **not** the override:
`r-clar-soda` ("a soda") returned an identical **355 g** in both runs, but the
model set `needs_clarification` true in one and false in the other. The override
returns a number and the resolver assigns only `grams`, so it cannot affect that
field. This is decode nondeterminism on a borderline case — the same case has
flipped between model revisions before. Worth knowing when reading any single
gate run: ±1 case in this category is noise, which is precisely the instability
the hybrid removes from the quantity category.

**The most important number is the spread, not the level.** Across three model
revisions the baseline swings 10.3 points; the hybrid swings 3.4. Accuracy stops
depending on which training round happened to be lucky.

### Why the DB is not the source of per-unit weights

`foods.db` `portions_json` looked like the obvious place to get grams-per-piece,
and it makes things markedly worse. Its labels are inconsistent: "1 piece" for
tater tots is the 8 g institutional school-lunch tot, not the ~15 g retail one;
a whole pizza row's first portion is the 508 g pie, which then gets multiplied by
a slice count. The curated pool weights in `generate-synthetic.mjs` are
hand-checked and already correct — so the table is lifted from there
(`tools/parse/build-portions.mjs` → `portions.json` + `mobile/src/lib/ai/portions.ts`).

Those weights previously reached the app only as something the model memorized,
and that channel is provably lossy: trained on 16 g per nugget and ~1400 g per
lasagna pan, the model returned 111 g and 143 g.

## Design: a confident override, never a replacement

`parseQuantity` reports only what it is certain of and returns `null` otherwise,
so anything ambiguous still falls through to the model. **A wrong parse is worse
than no parse** — it replaces a decent estimate with a confident wrong one. It
therefore declines:

- **multi-item text** (`"two scrambled eggs and a slice of whole wheat toast"`) —
  the count governs only the first food, and the parser reads the last noun, so
  firing would multiply the *toast* by two;
- **volume** (`"three cups of air-popped popcorn"`) — grams per cup depends on
  the food (popcorn ≈ 24 g, rice ≈ 480 g), which is knowledge;
- **hedged or vague amounts** (`"like 3-4 tacos ish"`, `"some chicken"`).

The volume decline exists because an earlier version got it wrong, caught by
auditing the grammar against the 55 real in-dist sentences — the adversarial
gate's terse single-food inputs never exposed it. On the in-dist set the grammar
fires on 3/55 cases and changes **0** of them.

A bare **"oz" beside a container** is the one ambiguity the grammar neither
resolves nor declines: `"a 12 oz can of cola"` is 12 fluid ounces (~355 g) while
`"a 12 oz can of tuna"` is 12 weight ounces (340 g). It reports `ambiguousOz` and
the resolver settles it against the matched row (see the on-hardware section
below). Declining was the earlier behaviour and it hid a 12x error.

The resolver applies the override only to **single-item claims**: with several
foods in play there is no way to know which one a lone stated quantity governs.
`assist.tsx` passes the original description and only on the first estimate —
after a clarification round a later answer may revise the amount.

The override runs *last*, taking the resolver's own answer as its baseline, so
branded serving-snapping is preserved: for `"2 big macs"` the per-unit weight is
recovered as `baseline / count`, not from the model's raw `unit_grams`.

## Files

| File | Role |
|---|---|
| `mobile/src/lib/ai/quantity.ts` | the grammar (ships) |
| `mobile/src/lib/ai/portion-lookup.ts` | table matching (ships) |
| `mobile/src/lib/ai/portions.ts` | generated weights (ships) |
| `mobile/src/lib/ai/resolver.ts` | `applyQuantityOverride` |
| `tools/parse/quantity.mjs` | the grammar, tools copy |
| `tools/parse/quantity-override.mjs` | override + lookup, shared by every harness |
| `tools/parse/build-portions.mjs` | lifts pool weights → both table copies |
| `tools/parse/quantity.test.mjs` | parse + decline unit tests |
| `tools/parse/parity-check.mjs` | proves the TS and mjs grammars agree |
| `tools/eval/quantity-sim.mjs` | the architecture comparison above |

### Keeping the copies honest

The app cannot import from `tools/`, and node cannot import TypeScript, so the
grammar necessarily exists twice. Every claim the gate makes about app behaviour
depends on the two agreeing, so `tools/parse/parity-check.mjs` compiles the
shipping copy and replays both over every real input available (151 adversarial +
55 in-dist + the test vectors — 211 in total). **Run it after touching either
copy.** The override itself is not duplicated: the eval harnesses
(`adversarial/run.mjs`, `run-eval.mjs`, `playground.mjs`) import
`quantity-override.mjs`, and `quantity-sim.mjs` calls it too, so the measured
architecture is literally the shipping logic.

`tools/eval/run-eval-n5k.mjs` is deliberately untouched: it is the photo eval and
has no user text, so the override is inert there.

## Verification

```bash
node tools/parse/quantity.test.mjs        # parse + decline behaviour
node tools/parse/parity-check.mjs         # TS and mjs grammars agree
node tools/eval/quantity-sim.mjs v10      # architecture comparison
cd mobile && npx tsc --noEmit && npx expo lint
```

## First on-hardware run (2026-08-12) and what it changed

Built with EAS, installed on a physical Android phone, running text-v2 (= the
**v8** GGUF). Decode measured **25–26 tok/s** on device — roughly half the 54
tok/s the 4-thread CPU proxy predicted, so ~4 s per single-item estimate.

The headline result is that the offline gate predicts hardware faithfully: on
"20 chicken nuggets" and "a pound of ground beef" the model's raw values on the
phone were 107 g and 181 g, within a gram or two of the failure values recorded
here (~105 g, ~182 g), and the override corrected both to 320 g and 454 g.

The run also found a real bug the gate could not have caught, because every gate
input was lowercase and trimmed while phone keyboards auto-capitalise:

**"a 12 oz can of coke" returns 4572 g on v10, deterministically (4/4 runs at
temperature 0). Capitalised, "A 12 oz can of coke" returns 368 g, also 4/4.**
A 12x swing on one letter, in the single most common thing people log. On v8 the
same input yields "carbonated water" — 0 kcal for a ~140 kcal drink.

The grammar had been *declining* on container+oz, so nothing caught it. That
decline is now replaced by an `ambiguousOz` reading which the **resolver**
settles against the matched row: foods.db knows what a drink is (an `ml` unit, a
category like Beverages / Soft drinks / Beer / Wine, or fl-oz portion labels on
1,207 of 14,558 rows). Fluid ounces where the match is a liquid, weight ounces
otherwise, and the model keeps the call when nothing matched. Knowledge from the
DB, arithmetic from code — the same split as the rest of this design.

Six device-realistic cases were added to the gate (capitalised inputs, a
trailing space, and the coke phrasings). All six pass on v8 and v10.

### Still broken: "coke" cannot resolve at all

The fix above corrects the *grams*. The *identity* half remains, and it is a
data gap rather than a model failure: **the token "coke" appears in 0 of the
14,558 foods.db rows**, in neither `name_norm` nor `display_name_norm`. It can
only resolve if the model translates "coke" → "cola" in its own search terms,
which it does not do reliably — v8 matched "Beverages, carbonated, tonic water",
v10 matched nothing and fell back to its own macros.

`r-ident-coke` and `r-ident-cokeoz` track this and are **expected to fail** until
an alias exists. Fixing it means either an alias overlay onto the DB
(`tools/db/overlays.mjs`) or synonym expansion in the shared search path — a
decision that touches either the DB build or all four resolver mirrors, so it is
deliberately left open rather than guessed at.

## What is still open

Four band cases remain, and none is a parsing problem — each is a per-piece
weight the curated table does not carry: `8 mini pancakes`, `two hot dogs`,
`half a burrito`, `two burgers`. Adding those to the generator's pools fixes them
in both the training data and the runtime table at once.

The model's remaining job is naming, unstated portions, OOD macros, and ambiguity
detection. Whether a 0.8B is still the right size for that is now an open,
measurable question — note the quantization route is closed (Q3_K_M drops median
APE from 2.1% to 22.1% and DB match to 92%), so any shrink means fewer
parameters or moving identification to embedding retrieval.
