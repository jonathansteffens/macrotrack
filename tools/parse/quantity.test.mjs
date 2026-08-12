// Unit tests for the deterministic quantity grammar.
//
// Two halves, and the second matters more than the first:
//   PARSE  — inputs the grammar must read exactly (this is why it exists).
//   DECLINE — inputs it must refuse. The grammar is wired as a confident
//     override of the model, so a wrong parse is worse than no parse: it
//     replaces a decent estimate with a confident wrong one. Every DECLINE case
//     below except the vague ones came from auditing the grammar against the 55
//     real in-dist eval sentences, where an earlier version fired on 40% of
//     inputs and mis-attached counts across conjunctions.
//
//   node tools/parse/quantity.test.mjs

import { parseQuantity } from './quantity.mjs';

let failures = 0;
const fail = (msg) => { console.error(`  FAIL ${msg}`); failures++; };

function expectParse(text, want) {
  const got = parseQuantity(text);
  if (!got) return fail(`"${text}": expected a parse, got null`);
  for (const [k, v] of Object.entries(want)) {
    if (got[k] !== v) return fail(`"${text}": ${k} = ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`);
  }
}
function expectDecline(text) {
  const got = parseQuantity(text);
  if (got) fail(`"${text}": expected null, got ${JSON.stringify(got)}`);
}

// ---- weights: exact conversions, the grammar's clearest win ----------------
console.log('weights:');
expectParse('a pound of ground beef', { kind: 'weight', grams: 454 });
expectParse('2 lbs of shrimp', { kind: 'weight', grams: 907 });
expectParse('a half pound turkey burger patty', { kind: 'weight', grams: 227 });
expectParse('half a pound of ground beef', { kind: 'weight', grams: 227 });
expectParse('a quarter pound burger', { kind: 'weight', grams: 113 });
expectParse('8 oz steak', { kind: 'weight', grams: 227 });
expectParse('6 oz of grilled chicken', { kind: 'weight', grams: 170 });
expectParse('150 g of cooked shrimp', { kind: 'weight', grams: 150 });

// ---- dozen idioms: "half a dozen" is 6, the v9 bagels failure --------------
console.log('dozen idioms:');
expectParse('half a dozen bagels', { kind: 'count', count: 6 });
expectParse('a half dozen doughnuts', { kind: 'count', count: 6 });
expectParse('a dozen dumplings', { kind: 'count', count: 12 });
expectParse('a dozen krispy kreme donuts', { kind: 'count', count: 12 });

// ---- counts ---------------------------------------------------------------
console.log('counts:');
expectParse('20 chicken nuggets', { kind: 'count', count: 20, unitNoun: 'nugget' });
expectParse('two beers', { kind: 'count', count: 2, unitNoun: 'beer' });
expectParse('16 tater tots', { kind: 'count', count: 16 });
expectParse('5 chicken mcnuggets from mcdonalds', { kind: 'count', count: 5 });
expectParse('eight meatballs', { kind: 'count', count: 8, unitNoun: 'meatball' });
expectParse('5 slices of pepperoni pizza', { kind: 'count', count: 5, unitNoun: 'slice', portionOf: 'pepperoni pizza' });

// ---- fractions and wholes --------------------------------------------------
console.log('fractions / wholes:');
expectParse('a quarter of the lasagna', { kind: 'fraction', fraction: 0.25, ofWhole: true });
expectParse('half a pizza', { kind: 'fraction', fraction: 0.5 });
expectParse('a third of a pie', { kind: 'fraction', fraction: 0.33 });
expectParse('a whole rotisserie chicken', { kind: 'whole', count: 1 });
expectParse('the whole bag of chips', { kind: 'whole', count: 1 });

// ---- meal frames are stripped, not parsed as content -----------------------
console.log('meal frames:');
expectParse('for lunch I had 20 chicken nuggets', { kind: 'count', count: 20 });
expectParse('dinner: 8 oz steak', { kind: 'weight', grams: 227 });

// ---- DECLINE: unsafe to override ------------------------------------------
console.log('declines:');
// Multi-item — the count governs only the first food, but unitFrom() reads the
// LAST noun, so firing would multiply the wrong food.
expectDecline('two scrambled eggs and a slice of whole wheat toast');
expectDecline('two slices of french toast with a tablespoon of maple syrup');
expectDecline('a beef burrito and two cups of romaine lettuce');
expectDecline('fries with ranch');
expectDecline('3 eggs, 2 slices of bacon');
// Volume needs the food's density: 3 cups of popcorn ~24 g, of rice ~480 g.
expectDecline('three cups of air-popped popcorn');
expectDecline('two cups of diced watermelon');
expectDecline('a cup and a half of cooked pasta');
expectDecline('12 fl oz of orange juice');   // never read "oz" here as 28.35 g
// A bare "oz" beside a container is weight-or-fluid depending on the contents:
// "12 oz can of cola" is ~355 g (fluid), "12 oz can of tuna" is 340 g (weight).
expectDecline('a 12 oz can of regular cola');
expectDecline('a 12 oz can of regular beer');
expectDecline('a 16 oz bottle of water');
// Vague or article-only: nothing the model does not already know.
expectDecline('some chicken');
expectDecline('a burger');
expectDecline('a soda');
expectDecline('');
expectDecline(null);
// Hedged counts — a range is not a count.
expectDecline('like 3-4 tacos ish');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall quantity-grammar checks passed');
process.exit(failures ? 1 : 0);
