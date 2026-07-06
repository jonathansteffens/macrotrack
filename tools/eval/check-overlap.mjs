// Verifies eval-set hold-out: no training sample may contain the same SET of
// resolved DB foods as any eval case. Combos are compared by canonical DB
// name (each item's first db_search_term resolved with the app's search),
// so paraphrased texts can't hide an overlap.
//
//   node tools/eval/check-overlap.mjs <training.jsonl> [more.jsonl ...]
//
// Exit code 1 if any overlap is found. Run this on every SFT file before
// training; generate-synthetic.mjs also skips these combos at generation time.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/eval/check-overlap.mjs <training.jsonl> [...]');
  process.exit(2);
}

const db = new DatabaseSync(join(HERE, '..', '..', 'mobile', 'assets', 'foods.db'), {
  readOnly: true,
});
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);

function search(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : all;
  if (!tokens.length) return null;
  const where = tokens.map(() => "(' ' || name_norm) LIKE ? ESCAPE '\\'").join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  return db
    .prepare(
      `SELECT name FROM foods WHERE ${where}
       ORDER BY CASE WHEN name_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT 1`
    )
    .get(...params, `${tokens[0]}%`);
}

const resolveCache = new Map();
function resolveName(term) {
  if (!resolveCache.has(term)) resolveCache.set(term, search(term)?.name ?? `?${term}`);
  return resolveCache.get(term);
}

const comboKey = (names) => [...new Set(names)].sort().join(' | ');

// Eval combos, from cases.jsonl ground truth (already canonical DB names)
const cases = readFileSync(join(HERE, 'cases.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const evalCombos = new Map(cases.map((c) => [comboKey(c.truth.map((t) => t.name)), c.id]));

let overlaps = 0;
let total = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  for (const line of lines) {
    total++;
    const sample = JSON.parse(line);
    const assistant = sample.messages?.findLast((m) => m.role === 'assistant');
    if (!assistant) continue;
    let claim;
    try {
      claim = JSON.parse(assistant.content);
    } catch {
      continue; // non-claim assistant turn (e.g. free text) — nothing to compare
    }
    if (!Array.isArray(claim.items)) continue;
    const names = claim.items.map((i) => resolveName(i.db_search_terms?.[0] ?? i.name));
    const hit = evalCombos.get(comboKey(names));
    if (hit) {
      overlaps++;
      if (overlaps <= 10)
        console.error(`OVERLAP with eval case "${hit}" in ${file}: ${names.join(', ')}`);
    }
  }
}

console.log(`${total} training samples checked against ${evalCombos.size} eval combos.`);
if (overlaps > 0) {
  console.error(`${overlaps} overlapping sample(s) found — remove them before training.`);
  process.exit(1);
}
console.log('No overlaps. Eval set is held out.');
