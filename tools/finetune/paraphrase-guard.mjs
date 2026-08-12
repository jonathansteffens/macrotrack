// Fidelity guard for the synthetic-data paraphrase pass (v10).
//
// generate-synthetic.mjs composes meals from foods.db, so the gold FoodClaim is
// exact BY CONSTRUCTION — but only for the template text it renders. The
// optional paraphrase pass then rewrites the user turn with a teacher model,
// and REWRITE_SYSTEM's "keep every quantity exactly the same" is an instruction,
// not a constraint: at temperature 0.9 the teacher drifts, and before v10 only a
// length check enforced anything.
//
// Measured by regenerating the v9 dataset unparaphrased at the same seed (claims
// are identical by construction, so rows align 1:1 and the rewrite is the only
// difference): 13.2% of 40,000 rows had a changed quantity signature. 5.7%
// GAINED a number the gold claim does not carry — "chicken nuggets" → "3 chicken
// nuggets" against a count=null / 96 g label — teaching the model that a stated
// count does not change grams. Drift concentrated in exactly the families the v9
// adversarial gate regressed on: fraction-of-dish 30.1%, dozen 21.7%, clarify
// 14.7%, weight-phrase 8.2%. Since the teacher is sampled fresh each
// regeneration, WHICH rows corrupt differs per round — so those families flip
// between revisions on paraphrase luck rather than on any change we made.
//
// A rewrite that changes the quantity signature or flips negation is discarded
// and the template text kept: still valid SFT, just less varied.
//
// Kept as its own module so the rule can be tested against real before/after
// pairs (tools/finetune/test-paraphrase-guard.mjs) rather than only exercised
// inside a 40k generation run.

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// Units that make a bare article a real quantity ("a cup" == "1 cup"), so benign
// article/number-word swaps are not mistaken for drift.
const QTY_UNIT = '(?:oz|ounces?|lbs?|pounds?|cups?|tbsps?|tablespoons?|tsps?|teaspoons?|grams?|g|slices?|pieces?|cans?|bottles?|box(?:es)?|bags?|sleeves?|loa(?:f|ves)|servings?|scoops?|handfuls?|bowls?|plates?)';

// Normalized multiset of every quantity the text states, as a sorted string.
// Equal signatures ⇒ the rewrite says the same amounts, however it phrases them.
export function qtySignature(text) {
  let t = ` ${text.toLowerCase()} `;
  // Dozen idioms first: "half a dozen" must read 6, not 0.5 and 12.
  t = t.replace(/\b(?:half a dozen|a half dozen)\b/g, ' 6 ');
  t = t.replace(/\ba dozen\b|\bdozen\b/g, ' 12 ');
  // Number words → digits before any "and a half" handling, so the word and
  // digit forms ("one and a half" / "1 and a half") collapse to one rule.
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), ` ${n} `);
  }
  // "and a half" attaches either to a bare number ("1 and a half cups") or to a
  // unit ("a cup and a half" — the same 1.5 cups, phrased unit-first).
  t = t.replace(new RegExp(`\\b(?:a|an|1)\\s+(${QTY_UNIT})\\s+and\\s+a\\s+half\\b`, 'g'), ' 1.5 $1 ');
  t = t.replace(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s+(${QTY_UNIT})\\s+and\\s+a\\s+half\\b`, 'g'),
    (_m, n, u) => ` ${Number(n) + 0.5} ${u} `);
  t = t.replace(/\b(\d+(?:\.\d+)?)\s+and\s+a\s+half\b/g, (_m, n) => ` ${Number(n) + 0.5} `);
  // Fractions after the idioms, since "1/2" carries digits that must not leak
  // into the generic number scan.
  t = t.replace(/\b(\d+)\s*\/\s*2\b/g, (_m, n) => ` ${Number(n) / 2} `);
  t = t.replace(/\bhalf\b/g, ' 0.5 ');
  t = t.replace(/\b1\s*\/\s*4\b|\bquarter\b/g, ' 0.25 ');
  t = t.replace(/\b1\s*\/\s*3\b|\bthird\b/g, ' 0.33 ');
  t = t.replace(new RegExp(`\\b(?:a|an)\\s+(${QTY_UNIT})\\b`, 'g'), ' 1 $1 ');
  // Vague count words are quantities too: "some soda" → "a couple of sodas"
  // injects a count the label does not have.
  t = t.replace(/\bcouple\b/g, ' 2 ').replace(/\b(?:few|several)\b/g, ' 3 ');
  return (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).sort((a, b) => a - b).join(',');
}

// Negation/plain markers must survive in BOTH directions: dropping one
// contradicts a claim that omits the removed component ("a plain hamburger,
// nothing on it" → a burger with cheese, the v9 r-cond-plainburger failure), and
// adding one contradicts a claim that includes it. Compared as a boolean rather
// than a set so an honest rephrase ("plain" → "nothing on it") still passes.
const NEGATION_RE = /\b(?:no|without|plain|nothing|hold the|sans|skip)\b/;
export const hasNegation = (t) => NEGATION_RE.test(t.toLowerCase());

export function paraphraseIsFaithful(orig, rewrite) {
  if (qtySignature(orig) !== qtySignature(rewrite)) return false;
  if (hasNegation(orig) !== hasNegation(rewrite)) return false;
  return true;
}
