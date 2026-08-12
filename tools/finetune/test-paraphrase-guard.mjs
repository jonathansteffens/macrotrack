// Tests the paraphrase fidelity guard two ways:
//
//   1. Unit cases — hand-written pairs covering the benign rephrasings the guard
//      MUST accept (article/number-word/fraction/idiom swaps) and the real
//      corruptions observed in the v9 dataset that it MUST reject.
//   2. Corpus replay (optional) — replays every real before/after pair from a
//      round: an unparaphrased regeneration (template text) against the shipped
//      paraphrased dataset, at the same seed so rows align 1:1. Reports the
//      rejection rate and, since template rows are the ground truth for
//      "unchanged", how many ACCEPTED rows still differ in text (that is the
//      diversity the guard preserves).
//
//   node tools/finetune/test-paraphrase-guard.mjs
//   node tools/finetune/test-paraphrase-guard.mjs <template.jsonl> <paraphrased.jsonl>

import { readFileSync } from 'node:fs';
import { qtySignature, paraphraseIsFaithful } from './paraphrase-guard.mjs';

let failures = 0;
const check = (label, got, want) => {
  if (got !== want) { console.error(`  FAIL ${label}: got ${got}, want ${want}`); failures++; }
};

// ---- 1. accept: benign rephrasings that keep every quantity ----------------
const ACCEPT = [
  ['two cups of vanilla ice cream and a cup of strawberries', '2 cups vanilla ice cream, 1 cup strawberries'],
  ['for lunch: two small roasted chicken breasts', '2 small roasted chicken breasts'],
  ['1/2 of the chocolate cake', 'half the chocolate cake'],
  ['a half dozen doughnuts', 'half a dozen doughnuts'],
  ['one and a half cups of brown rice', '1.5 cups of brown rice'],
  ['a dozen wings', '12 wings'],
  ['for dinner I ate 3 hard-boiled eggs', 'Dinner was 3 hard-boiled eggs.'],
  ['a chicken burrito with no rice', 'chicken burrito, no rice'],
  ['a plain hamburger, nothing on it', 'plain hamburger with nothing on it'],
  ['150 g of cooked shrimp over a cup and a half of cooked pasta', '150g cooked shrimp over 1.5 cups pasta'],
];
console.log('accept (benign rephrasings):');
for (const [a, b] of ACCEPT) check(`"${a}" -> "${b}"`, paraphraseIsFaithful(a, b), true);

// ---- 2. reject: the real corruptions measured in the v9 dataset ------------
const REJECT = [
  // teacher INVENTS a count the count=null label does not carry (5.7% of rows)
  ['chicken nuggets topped with ranch', '3 chicken nuggets, topped w/ ranch dressing.'],
  ['chicken nuggets', '2 chicken nuggets'],
  // vague amount becomes a count — the clarify-family corruption
  ['some soda', 'Sipped a couple of sodas.'],
  // count changed outright
  ['12 dumplings', '10 dumplings'],
  ['half a dozen bagels', 'a dozen bagels'],
  // fraction-of-dish drift (30.1% of fraction rows)
  ['a quarter of the lasagna', 'half the lasagna'],
  // weight phrase dropped
  ['a half pound turkey burger patty', 'a turkey burger patty'],
  // negation dropped: label omits the removed component, text no longer does
  ['a chicken burrito with no rice', 'a chicken burrito'],
  ['a plain hamburger, nothing on it', 'a hamburger'],
];
console.log('reject (measured corruptions):');
for (const [a, b] of REJECT) check(`"${a}" -> "${b}"`, paraphraseIsFaithful(a, b), false);

// ---- 3. signature sanity ---------------------------------------------------
console.log('signature:');
check('half a dozen == 6', qtySignature('half a dozen bagels'), qtySignature('6 bagels'));
check('a dozen == 12', qtySignature('a dozen eggs'), qtySignature('12 eggs'));
check('a cup == 1 cup', qtySignature('a cup of rice'), qtySignature('1 cup of rice'));
check('quarter == 0.25', qtySignature('a quarter of the pie'), qtySignature('0.25 of the pie'));
check('couple counts', qtySignature('a couple of sodas') !== qtySignature('some soda'), true);

// ---- 4. corpus replay (optional) -------------------------------------------
const [tmplPath, paraPath] = process.argv.slice(2);
if (tmplPath && paraPath) {
  const load = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tmpl = load(tmplPath);
  const para = load(paraPath);
  if (tmpl.length !== para.length) {
    console.error(`\ncorpus replay: length mismatch ${tmpl.length} vs ${para.length}`);
    failures++;
  } else {
    let claimsEqual = 0, rejected = 0, acceptedAndVaried = 0, acceptedIdentical = 0;
    for (let i = 0; i < tmpl.length; i++) {
      if (tmpl[i].messages[2].content === para[i].messages[2].content) claimsEqual++;
      const a = tmpl[i].messages[1].content;
      const b = para[i].messages[1].content;
      if (!paraphraseIsFaithful(a, b)) rejected++;
      else if (a !== b) acceptedAndVaried++;
      else acceptedIdentical++;
    }
    const n = tmpl.length;
    // A row whose text is unchanged always passes, so the rows the teacher
    // actually rewrote are the rejected ones plus the accepted-and-varied ones.
    // That is the honest denominator for "how often does the teacher drift" —
    // the whole-corpus rate is diluted by --paraphrase-frac.
    const rewritten = rejected + acceptedAndVaried;
    console.log(`\ncorpus replay over ${n} aligned rows:`);
    console.log(`  claims identical (alignment sanity): ${claimsEqual}/${n}`);
    console.log(`  REJECTED (drifted, template kept)  : ${rejected} (${(rejected / n * 100).toFixed(1)}% of corpus, ` +
      `${(rejected / rewritten * 100).toFixed(1)}% of the ${rewritten} rows the teacher actually rewrote)`);
    console.log(`  accepted and reworded (diversity)  : ${acceptedAndVaried} (${(acceptedAndVaried / n * 100).toFixed(1)}%)`);
    console.log(`  accepted, unchanged text           : ${acceptedIdentical} (${(acceptedIdentical / n * 100).toFixed(1)}%)`);
    if (claimsEqual !== n) { console.error('  FAIL: rows are not aligned — regenerate at the same seed'); failures++; }
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall guard checks passed');
process.exit(failures ? 1 : 0);
