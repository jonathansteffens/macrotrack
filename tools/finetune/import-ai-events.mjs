// Imports ai_events exports (docs/ai-events-format.md v1, written by the app's
// exportTrainingData() in mobile/src/lib/export.ts) into SFT training data,
// shaped exactly like tools/finetune/generate-synthetic.mjs's output:
// one {messages:[system,user,assistant]} JSONL line per row, assistant content
// = JSON.stringify(FoodClaim). The system prompt is extracted live from
// mobile/src/lib/ai/prompt.ts so it can never drift from what ships.
//
//   node tools/finetune/import-ai-events.mjs <ai-events-*.jsonl...> \
//     [--out-dir data/sft] [--oversample 3] [--holdout 0.2] [--seed 1]
//
// What a "row" is, and why some get skipped:
//   Only rows the app itself would emit are valid: v === 1, a non-empty
//   user_text, and a final_claim with an items array (see the format doc and
//   finalClaimFor() in mobile/src/lib/ai/events.ts). Anything else (wrong
//   version, missing text, malformed final_claim) is counted "invalid".
//
//   The FoodClaim/ClaimItem schema (mobile/src/lib/ai/schema.ts) REQUIRES
//   est_per100 on every item, but the app's finalClaimFor() only logs
//   est_per100 for items the food-database match FAILED to resolve — when a
//   DB match was found it logs db_search_terms instead and omits est_per100
//   (the app doesn't need the model's own macro guess once it has the real
//   DB numbers). This importer has no DB access, so it cannot invent
//   est_per100 for a matched item: such items are dropped, and if a row's
//   final_claim.items has zero items left after that (including a final_claim
//   that already had 0 items — the user deleted everything before saving),
//   the whole row is skipped as "item-less". In practice this means only the
//   subset of corrections that involve an unmatched food currently produce
//   trainable rows here — a known limitation, not a bug; teaching the
//   importer to look est_per100 up from foods.db by db_search_terms is a
//   reasonable follow-up but out of scope for this pass.
//
//   Missing per-item fields are filled to match the full schema shape:
//   count/unit_grams -> null when absent, prep -> null when absent,
//   confidence -> 0.9 when absent (the app never logs prep/confidence on
//   final_claim items at all), db_search_terms -> [] when absent.
//   needs_clarification/questions are always false/[] on the assistant
//   message: by the time a claim is saved (with or without a prior
//   clarification round), the model's own claim state was already resolved.
//
// Train/holdout: rows are seeded-shuffled (mulberry32, same style RNG as
// generate-synthetic.mjs) so a given --seed always produces the same split
// across runs, independent of input file argument order (input files are
// sorted before reading). `holdout` fraction of rows go to
// ai-events-heldout.jsonl once, unweighted (an eval slice, per the format
// doc). The rest go to ai-events-train.jsonl; rows whose `edits` array is
// non-empty (a real correction) are repeated --oversample times there, since
// they encode the model's actual failure modes; zero-edit rows (the model
// was right) appear once, as regularization.
//
// NEXT-CYCLE (not done here): train_text_sft.py currently reads a single
// dataset via its `text_sft` config key (data/sft/sft-text.jsonl). Wiring
// these ai-events-train/heldout.jsonl files into the trainer -- e.g. an
// `extra_sft` config key listing additional JSONL paths to mix in, with the
// heldout file feeding a correction-specific validity/regression probe -- is
// a follow-up change. This script only produces the files; per instructions
// train_text_sft.py itself is not touched here.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

// Positional args (input files) are everything not immediately after a `--flag`.
const files = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { i++; continue; } // skip the flag and its value
  files.push(a);
}

if (files.length === 0) {
  console.error(
    'Usage: node tools/finetune/import-ai-events.mjs <ai-events-*.jsonl...> ' +
      '[--out-dir data/sft] [--oversample 3] [--holdout 0.2] [--seed 1]'
  );
  process.exit(1);
}

const OUT_DIR = arg('out-dir', join(ROOT, 'data', 'sft'));
const OVERSAMPLE = Math.max(1, parseInt(arg('oversample', '3'), 10));
const HOLDOUT = Math.min(1, Math.max(0, parseFloat(arg('holdout', '0.2'))));
const SEED = parseInt(arg('seed', '1'), 10);

// ---- System prompt from the app (no drift) ----
const SYSTEM_PROMPT = readFileSync(
  join(ROOT, 'mobile', 'src', 'lib', 'ai', 'prompt.ts'),
  'utf8'
).match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

// ---- Deterministic RNG (mulberry32), same construction as generate-synthetic.mjs ----
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const MEAL_GUESSES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);

/** One final_claim item -> a full ClaimItem, or null if it can't be shaped
 *  (no grams, or no derivable est_per100). Field order matches
 *  mobile/src/lib/ai/schema.ts's `required` order exactly. */
function transformItem(raw) {
  if (!raw || typeof raw.name !== 'string' || typeof raw.grams !== 'number' || !Number.isFinite(raw.grams)) {
    return null;
  }
  const src = raw.est_per100;
  if (!src || typeof src !== 'object') return null; // nothing to derive it from -- drop
  const est_per100 = {
    kcal: Number(src.kcal) || 0,
    protein: Number(src.protein) || 0,
    carbs: Number(src.carbs) || 0,
    fat: Number(src.fat) || 0,
  };
  return {
    name: raw.name,
    count: typeof raw.count === 'number' ? raw.count : null,
    unit_grams: typeof raw.unit_grams === 'number' ? raw.unit_grams : null,
    grams: raw.grams,
    prep: typeof raw.prep === 'string' ? raw.prep : null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.9,
    db_search_terms: Array.isArray(raw.db_search_terms) ? raw.db_search_terms : [],
    est_per100,
  };
}

/** Returns { sample, edited, droppedItems } for a valid, non-empty row, or
 *  { skip: 'invalid' | 'item-less', droppedItems } otherwise. */
function processRow(row) {
  if (!row || row.v !== 1) return { skip: 'invalid', droppedItems: 0 };
  if (typeof row.user_text !== 'string' || row.user_text.trim().length === 0) {
    return { skip: 'invalid', droppedItems: 0 };
  }
  if (!row.final_claim || !Array.isArray(row.final_claim.items)) {
    return { skip: 'invalid', droppedItems: 0 };
  }
  const items = row.final_claim.items.map(transformItem).filter(Boolean);
  const droppedItems = row.final_claim.items.length - items.length;
  if (items.length === 0) return { skip: 'item-less', droppedItems };

  const meal_guess = MEAL_GUESSES.has(row.final_claim.meal_guess) ? row.final_claim.meal_guess : 'snack';
  const claim = { items, needs_clarification: false, questions: [], meal_guess };
  const edits = Array.isArray(row.edits) ? row.edits : [];
  const sample = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: row.user_text },
      { role: 'assistant', content: JSON.stringify(claim) },
    ],
  };
  return { sample, edited: edits.length > 0, droppedItems };
}

// ---- Read + transform ----
let rowsIn = 0;
let invalid = 0;
let itemLess = 0;
let itemsDropped = 0;
const valid = []; // { sample, edited }

for (const f of files.slice().sort()) {
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rowsIn++;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      invalid++;
      continue;
    }
    const result = processRow(row);
    itemsDropped += result.droppedItems;
    if (result.skip === 'invalid') { invalid++; continue; }
    if (result.skip === 'item-less') { itemLess++; continue; }
    valid.push(result);
  }
}

// ---- Deterministic shuffle + split ----
const rng = makeRng(SEED);
const shuffled = seededShuffle(valid, rng);
const holdoutCount = Math.round(shuffled.length * HOLDOUT);
const heldoutSet = shuffled.slice(0, holdoutCount);
const trainSet = shuffled.slice(holdoutCount);

const trainLines = [];
for (const entry of trainSet) {
  const reps = entry.edited ? OVERSAMPLE : 1;
  for (let i = 0; i < reps; i++) trainLines.push(JSON.stringify(entry.sample));
}
const heldoutLines = heldoutSet.map((e) => JSON.stringify(e.sample));

mkdirSync(OUT_DIR, { recursive: true });
const trainPath = join(OUT_DIR, 'ai-events-train.jsonl');
const heldoutPath = join(OUT_DIR, 'ai-events-heldout.jsonl');
writeFileSync(trainPath, trainLines.length ? trainLines.join('\n') + '\n' : '');
writeFileSync(heldoutPath, heldoutLines.length ? heldoutLines.join('\n') + '\n' : '');

// ---- Stats ----
const editedCount = valid.filter((e) => e.edited).length;
const editedShare = valid.length ? ((100 * editedCount) / valid.length).toFixed(1) : '0.0';
console.log(`ai_events import (seed ${SEED}, oversample ${OVERSAMPLE}x, holdout ${HOLDOUT})`);
console.log(`  input files: ${files.length}`);
console.log(`  rows in: ${rowsIn}`);
console.log(`  invalid (skipped): ${invalid}`);
console.log(`  item-less (skipped, no derivable est_per100 on any item): ${itemLess}`);
console.log(`  items dropped from otherwise-kept rows (no derivable est_per100): ${itemsDropped}`);
console.log(`  valid rows: ${valid.length} (edited: ${editedCount}, ${editedShare}%)`);
console.log(`  holdout rows: ${heldoutSet.length} -> ${heldoutPath}`);
console.log(`  train rows: ${trainSet.length} pre-oversample, ${trainLines.length} written -> ${trainPath}`);
