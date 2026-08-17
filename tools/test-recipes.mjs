// Tests the recipe arithmetic in mobile/src/lib/recipes.ts.
//
// Three things worth locking down, all of them easy to get inverted and all of
// them silent when wrong:
//
//   recipeItemFromManual     label macros -> stored per-100g
//   recipeServingGrams       batch weight -> weight of one serving
//   servingsForServingGrams  the inverse, so the editor works from either end
//
// Compiled with the project's own tsc and run under node (the app has no test
// runner) — same approach as tools/test-units.mjs.
//
//   node tools/test-recipes.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// See tools/parse/parity-check.mjs for why this goes through process.execPath.
const TSC = join(ROOT, 'mobile/node_modules/typescript/bin/tsc');

const out = mkdtempSync(join(tmpdir(), 'mt-recipes-'));
// recipes.ts imports ./db (expo-sqlite), which cannot load under node — but the
// aggregation helpers never touch it. Stub the module so the import resolves and
// only the pure functions are exercised.
try {
  execFileSync(process.execPath, [
    TSC, join(ROOT, 'mobile/src/lib/recipes.ts'),
    '--outDir', out, '--module', 'esnext', '--target', 'es2022',
    '--moduleResolution', 'bundler', '--skipLibCheck',
  ], { stdio: 'pipe' });
} catch (e) {
  const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (!msg.includes('error TS')) { console.error(msg || e.message); process.exit(1); }
}
writeFileSync(join(out, 'package.json'), '{"type":"module"}');
writeFileSync(join(out, 'db.js'), 'export const getUserDb = () => { throw new Error("db unused in these tests"); };\n');

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
const R = await import(pathToFileURL(join(out, 'recipes.js')).href);

let failures = 0;
const eq = (label, got, want) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) < 1e-6 : got === want;
  if (!ok) { console.error(`  FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

console.log('manual ingredient, macros typed FOR the amount:');
{
  // 50 g of peanut butter, label says 300 kcal for that 50 g.
  const it = R.recipeItemFromManual({
    name: 'peanut butter', grams: 50, basis: 'amount',
    macros: { kcal: 300, protein: 12, carbs: 10, fat: 25 },
  });
  eq('stored per-100g kcal', it.per100.kcal, 600);
  eq('stored per-100g protein', it.per100.protein, 24);
  eq('grams kept as typed', it.grams, 50);
  eq('no food ref', it.foodRef, null);
  eq('unknown micros stay null, not zero', it.per100.fiber, null);
  // The round trip is what matters: scaling per100 back to the amount must
  // reproduce the number the user read off the label.
  const back = R.recipeTotals({ id: 0, name: '', servings: 1, items: [it] });
  eq('round-trips to the label value', back.kcal, 300);
}

console.log('manual ingredient, macros typed PER 100 g:');
{
  const it = R.recipeItemFromManual({
    name: 'olive oil', grams: 14, basis: 'per100',
    macros: { kcal: 884, protein: 0, carbs: 0, fat: 100 },
  });
  eq('taken as-is', it.per100.kcal, 884);
  const back = R.recipeTotals({ id: 0, name: '', servings: 1, items: [it] });
  eq('14 g of oil', back.kcal, 884 * 0.14);
}

console.log('manual ingredient guards:');
eq('zero grams rejected', R.recipeItemFromManual({ name: 'x', grams: 0, basis: 'amount', macros: { kcal: 1, protein: 0, carbs: 0, fat: 0 } }), null);
eq('negative grams rejected', R.recipeItemFromManual({ name: 'x', grams: -5, basis: 'amount', macros: { kcal: 1, protein: 0, carbs: 0, fat: 0 } }), null);
{
  // Blank macros are legitimate: water, salt, spices.
  const it = R.recipeItemFromManual({ name: 'water', grams: 200, basis: 'amount', macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } });
  eq('zero-calorie ingredient is allowed', it.per100.kcal, 0);
  eq('  and named', it.foodName, 'water');
}
eq('blank name gets a fallback', R.recipeItemFromManual({ name: '   ', grams: 10, basis: 'per100', macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } }).foodName, 'Ingredient');

console.log('serving size, from either end:');
{
  const per100 = { kcal: 100, protein: 5, carbs: 10, fat: 2, fiber: null, sugar: null, sodiumMg: null, satFat: null, cholesterolMg: null, calciumMg: null, ironMg: null, potassiumMg: null };
  const recipe = { id: 0, name: 'chili', servings: 4, items: [
    { foodName: 'a', foodRef: null, grams: 600, per100 },
    { foodName: 'b', foodRef: null, grams: 400, per100 },
  ] };
  eq('batch weight', R.recipeTotalGrams(recipe), 1000);
  eq('one serving weighs', R.recipeServingGrams(recipe), 250);
  eq('inverse: 250 g/serving -> 4 servings', R.servingsForServingGrams(recipe, 250), 4);
  eq('inverse: 200 g/serving -> 5 servings', R.servingsForServingGrams(recipe, 200), 5);
  eq('per-serving macros', R.recipePerServing(recipe).kcal, 250);
  // An empty or nonsensical target has no answer rather than a wrong one.
  eq('zero target rejected', R.servingsForServingGrams(recipe, 0), null);
  eq('empty batch rejected', R.servingsForServingGrams({ id: 0, name: '', servings: 1, items: [] }, 100), null);
  eq('empty batch has no serving weight', R.recipeServingGrams({ id: 0, name: '', servings: 4, items: [] }), 0);
}

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall recipe checks passed');
process.exit(failures ? 1 : 0);
