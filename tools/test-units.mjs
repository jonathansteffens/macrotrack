// Tests the display-unit conversions in mobile/src/lib/units.ts.
//
// The app has no test runner, so this compiles the module (and the
// portion-lookup / portions modules it pulls in) with the project's own tsc and
// exercises the emitted JS from node — the same approach as
// tools/parse/parity-check.mjs.
//
//   node tools/test-units.mjs
//
// Two halves. The display half asserts how an amount READS. The input half
// asserts how a typed amount converts back INTO grams — amount fields are
// denominated in the food's own unit, but grams remain the stored value, so the
// conversion happens at the input boundary. That is what keeps "the stored gram
// value is never changed by any of this" true now that fields are not in grams.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Invoke the TypeScript entrypoint through node itself rather than the
// node_modules/.bin shim. On Windows the shim is tsc.cmd, and Node's
// CVE-2024-27980 hardening makes execFileSync of a .cmd/.bat throw EINVAL
// unless `shell: true` — so naming the .cmd only trades ENOENT for EINVAL.
// Running `process.execPath <pkg>/bin/tsc` sidesteps shims entirely and is the
// only form portable across platforms. Use this pattern for any tool that
// shells out to a node_modules binary.
const TSC = join(ROOT, 'mobile/node_modules/typescript/bin/tsc');

const out = mkdtempSync(join(tmpdir(), 'mt-units-'));
try {
  execFileSync(process.execPath, [
    TSC,
    join(ROOT, 'mobile/src/lib/units.ts'),
    '--outDir', out, '--module', 'esnext', '--target', 'es2022',
    '--moduleResolution', 'bundler', '--skipLibCheck',
  ], { stdio: 'pipe' });
} catch (e) {
  const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (!msg.includes('error TS')) { console.error(msg || e.message); process.exit(1); }
}
writeFileSync(join(out, 'package.json'), '{"type":"module"}');

// The app's source uses extensionless relative imports (correct for the RN
// bundler), and tsc emits them unchanged — but node's ESM loader requires the
// extension. Append it in the emitted copy only; the source is untouched.
function addJsExtensions(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { addJsExtensions(p); continue; }
    if (!name.endsWith('.js')) continue;
    writeFileSync(p, readFileSync(p, 'utf8').replace(
      /(\bfrom\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
      (m, a, spec, z) => (/\.[cm]?js$/.test(spec) ? m : `${a}${spec}.js${z}`)
    ));
  }
}
addJsExtensions(out);

const U = await import(pathToFileURL(join(out, 'units.js')).href);

let failures = 0;
const fail = (m) => { console.error(`  FAIL ${m}`); failures++; };
const eq = (label, got, want) => { if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

const US = { system: 'us', overrides: {} };
const METRIC = { system: 'metric', overrides: {} };
// A drink row as foods.db describes one.
const COLA = { category: 'Soft drinks', portions: [{ label: '1 fl oz', grams: 29.6 }], unit: 'g' };
const STEAK = { category: 'Beef Products', portions: [], unit: 'g' };

console.log('drinks:');
{
  const a = U.formatAmount(355, { name: 'cola', match: COLA, prefs: US });
  eq('355 g cola (US)', a.primary, '12 fl oz');
  eq('  keeps grams visible', a.secondary, '355 g');
}
{
  const a = U.formatAmount(355, { name: 'cola', match: COLA, prefs: METRIC });
  eq('355 g cola (metric)', a.primary, '355 mL');
}
{
  const a = U.formatAmount(355, { name: 'cola', match: COLA, prefs: { system: 'us', overrides: { drink: 'cup' } } });
  eq('cup override', a.primary, '1.5 cups');
}
{
  // No FoodItem (a logged entry) but the entry's own unit says it is a drink.
  const a = U.formatAmount(355, { name: 'coke', match: null, prefs: US, liquid: true });
  eq('liquid hint without a match', a.primary, '12 fl oz');
}

console.log('countable:');
{
  // 16 g/nugget comes from the curated pool table, the same source the
  // estimator was trained on.
  const a = U.formatAmount(320, { name: 'chicken nuggets', match: null, prefs: US });
  eq('320 g of nuggets', a.primary, '20 nuggets');
  eq('  keeps grams visible', a.secondary, '320 g');
}
{
  const a = U.formatAmount(16, { name: 'chicken nuggets', match: null, prefs: US });
  eq('one nugget is singular', a.primary, '1 nugget');
}
{
  // Half-steps are legitimate: 250 g is 15.625 nuggets, close enough to 15.5
  // that "15.5 nuggets" is an honest reading.
  const a = U.formatAmount(250, { name: 'chicken nuggets', match: null, prefs: US });
  eq('half-steps are allowed', a.primary, '15.5 nuggets');
}
{
  // 244 g is 15.25 nuggets — not near any half-step, so the user weighed it
  // rather than counted it and a count would be false precision.
  const a = U.formatAmount(244, { name: 'chicken nuggets', match: null, prefs: US });
  eq('count far from a half-step falls back to weight', a.primary, '8.6 oz');
}
{
  const a = U.formatAmount(320, { name: 'chicken nuggets', match: null, prefs: { system: 'us', overrides: { countable: 'g' } } });
  eq('countable override to grams', a.primary, '320 g');
  eq('  no redundant secondary', a.secondary, null);
}

console.log('servings (packaged foods and recipes):');
{
  // A barcode product's label serving, as off.ts records it.
  const BAR = { category: null, unit: 'g', portions: [{ label: '1 serving (30 g)', grams: 30 }] };
  eq('classify', U.classifyFood('granola bar', BAR), 'serving');
  const a = U.formatAmount(30, { name: 'granola bar', match: BAR, prefs: US });
  eq('one serving', a.primary, '1 serving');
  eq('  keeps grams visible', a.secondary, '30 g');
  eq('two servings', U.formatAmount(60, { name: 'granola bar', match: BAR, prefs: US }).primary, '2 servings');
  eq('fractional servings', U.formatAmount(45, { name: 'granola bar', match: BAR, prefs: US }).primary, '1.5 servings');
  // A stated serving beats the drink class: a scanned soda reads as the label does.
  const SODA = { category: 'Soft drinks', unit: 'g', portions: [{ label: '1 serving (355 ml)', grams: 355 }] };
  eq('serving beats drink', U.classifyFood('cola', SODA), 'serving');
  eq('  reads as servings', U.formatAmount(355, { name: 'cola', match: SODA, prefs: US }).primary, '1 serving');
  // ...unless the user overrides the class back to fl oz.
  eq('  override to fl oz', U.formatAmount(355, { name: 'cola', match: SODA, prefs: { system: 'us', overrides: { serving: 'floz' } } }).primary, '12 fl oz');
  // No stated serving -> weight, not raw grams, for a US user.
  eq('no serving falls back to oz', U.formatAmount(227, { name: 'mystery', match: { category: null, unit: 'g', portions: [] }, prefs: { system: 'us', overrides: { solid: 'auto' } } }).primary, '8 oz');
  eq('toGrams serving', U.toGrams(2, 'serving', 30), 60);
  eq('toGrams serving without a weight', U.toGrams(2, 'serving', null), null);
}

console.log('piece nouns:');
{
  // FNDDS-style rows trail qualifiers; the counting noun must come from the
  // unit portion's head, never the name's last word ("eaten" -> "eatens" bug).
  const CB = {
    category: null,
    unit: 'g',
    portions: [{ label: '1 breast, NS as to skin eaten', grams: 172 }],
  };
  eq(
    'noun from the unit portion, not name-tail junk',
    U.pieceNoun('Chicken breast, NS as to cooking method, skin not eaten', CB),
    'breast'
  );
  eq('same portion supplies the weight', U.pieceGramsFor('chicken breast xyz', CB), 172);
  eq(
    'name fallback cuts at the first comma',
    U.pieceNoun('Chicken breast, skin not eaten', { category: null, unit: 'g', portions: [] }),
    'breast'
  );
}

console.log('solids:');
eq('227 g steak (US)', U.formatAmount(227, { name: 'steak', match: STEAK, prefs: US }).primary, '8 oz');
eq('227 g steak (metric)', U.formatAmount(227, { name: 'steak', match: STEAK, prefs: METRIC }).primary, '227 g');
eq('  metric has no secondary', U.formatAmount(227, { name: 'steak', match: STEAK, prefs: METRIC }).secondary, null);

console.log('labels and round-trips:');
eq('amountLabel', U.amountLabel({ primary: '12 fl oz', secondary: '355 g' }), '12 fl oz (355 g)');
eq('amountLabel without secondary', U.amountLabel({ primary: '227 g', secondary: null }), '227 g');
eq('toGrams floz', Math.round(U.toGrams(12, 'floz', null)), 355);
eq('toGrams oz', Math.round(U.toGrams(8, 'oz', null)), 227);
eq('toGrams piece', U.toGrams(20, 'piece', 16), 320);
eq('toGrams piece without a weight', U.toGrams(20, 'piece', null), null);

console.log('input units — what a field opens in:');
{
  const BAR = { category: null, unit: 'g', portions: [{ label: '1 serving (30 g)', grams: 30 }] };
  const opts = U.amountUnitOptions({ name: 'granola bar', match: BAR, prefs: US });
  eq('packaged food opens in servings', opts[0].choice, 'serving');
  eq('  per-unit carried for conversion', opts[0].perUnit, 30);
  eq('  grams always remains offered', opts.some((o) => o.choice === 'g'), true);
  eq('  grams is never the default here', opts[0].choice === 'g', false);
}
{
  const opts = U.amountUnitOptions({ name: 'chicken nuggets', match: null, prefs: US });
  eq('countable food opens in pieces', opts[0].choice, 'piece');
  eq('  labelled with the food noun', opts[0].label, 'nuggets');
  eq('  per-piece weight from the curated table', opts[0].perUnit, 16);
}
{
  const COLA = { category: 'Soft drinks', unit: 'g', portions: [{ label: '1 fl oz', grams: 29.6 }] };
  eq('drink opens in fl oz (US)', U.amountUnitOptions({ name: 'cola', match: COLA, prefs: US })[0].choice, 'floz');
  eq('drink opens in mL (metric)', U.amountUnitOptions({ name: 'cola', match: COLA, prefs: METRIC })[0].choice, 'ml');
}
{
  const STEAK2 = { category: 'Beef Products', unit: 'g', portions: [] };
  eq('US solid opens in oz', U.amountUnitOptions({ name: 'steak', match: STEAK2, prefs: US })[0].choice, 'oz');
  eq('metric solid opens in grams', U.amountUnitOptions({ name: 'steak', match: STEAK2, prefs: METRIC })[0].choice, 'g');
}
{
  // A count-based unit with no known per-unit weight must not be offered — a
  // chip that cannot convert what the user types is worse than no chip.
  const opts = U.amountUnitOptions({ name: 'mystery stew', match: { category: null, unit: 'g', portions: [] }, prefs: US });
  eq('no piece weight -> no pieces chip', opts.some((o) => o.choice === 'piece'), false);
  eq('no serving -> no servings chip', opts.some((o) => o.choice === 'serving'), false);
}
{
  // A Settings override becomes the field's default too.
  const opts = U.amountUnitOptions({
    name: 'chicken nuggets', match: null,
    prefs: { system: 'us', overrides: { countable: 'g' } },
  });
  eq('override drives the input default', opts[0].choice, 'g');
}

console.log('input units — typed value converts back to grams:');
eq('2 servings of a 30 g bar', U.toGrams(2, 'serving', 30), 60);
eq('3 nuggets', U.toGrams(3, 'piece', 16), 48);
eq('12 fl oz', Math.round(U.toGrams(12, 'floz', null)), 355);
eq('8 oz', Math.round(U.toGrams(8, 'oz', null)), 227);
eq('grams pass through', U.toGrams(150, 'g', null), 150);

console.log('input units — round trip grams -> unit -> grams:');
for (const [choice, perUnit, grams] of [
  ['serving', 30, 90], ['piece', 16, 320], ['floz', null, 355],
  ['oz', null, 227], ['g', null, 150],
]) {
  const shown = U.gramsToUnit(grams, choice, perUnit);
  const back = U.toGrams(shown, choice, perUnit);
  if (Math.abs(back - grams) > 0.01) {
    console.error(`  FAIL round trip ${choice}: ${grams} -> ${shown} -> ${back}`);
    failures++;
  }
}
eq('gramsToUnit needs a per-unit weight for counts', U.gramsToUnit(100, 'piece', null), null);

console.log('edge cases:');
eq('zero', U.formatAmount(0, { name: 'cola', match: COLA, prefs: US }).primary, '0 g');
eq('NaN', U.formatAmount(NaN, { name: 'cola', match: COLA, prefs: US }).secondary, null);
eq('classify drink', U.classifyFood('cola', COLA), 'drink');
eq('classify countable', U.classifyFood('chicken nuggets', null), 'countable');
eq('classify solid', U.classifyFood('steak', STEAK), 'solid');

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall unit-display checks passed');
process.exit(failures ? 1 : 0);
