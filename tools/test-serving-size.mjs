// Tests the OpenFoodFacts serving_size label parser
// (mobile/src/lib/serving-size.ts).
//
// This decides whether a scanned product logs in SERVINGS or in grams, so it is
// worth locking down: OFF's serving_size is unstructured label text typed by
// contributors, and a wrong parse silently rescales every macro on the product.
// The rule is deliberately conservative — anything unrecognised returns null and
// the app falls back to grams rather than inventing a serving weight.
//
//   node tools/test-serving-size.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// See tools/parse/parity-check.mjs for why this goes through process.execPath.
const TSC = join(ROOT, 'mobile/node_modules/typescript/bin/tsc');

const out = mkdtempSync(join(tmpdir(), 'mt-serving-'));
try {
  execFileSync(process.execPath, [
    TSC, join(ROOT, 'mobile/src/lib/serving-size.ts'),
    '--outDir', out, '--module', 'esnext', '--target', 'es2022',
    '--moduleResolution', 'bundler', '--skipLibCheck',
  ], { stdio: 'pipe' });
} catch (e) {
  const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (!msg.includes('error TS')) { console.error(msg || e.message); process.exit(1); }
}
writeFileSync(join(out, 'package.json'), '{"type":"module"}');
const { parseServingSize } = await import(pathToFileURL(join(out, 'serving-size.js')).href);

let failures = 0;
const eq = (input, want) => {
  const got = parseServingSize(input);
  if (got !== want) {
    console.error(`  FAIL ${JSON.stringify(input)}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failures++;
  }
};

console.log('plain metric weights:');
eq('30 g', 30);
eq('30g', 30);
eq('30 grams', 30);
eq('  55 G  ', 55);
eq('0,5 g', 0.5);          // comma decimal, common on EU labels
eq('1 kg', 1000);

console.log('volumes (ml treated as g, as elsewhere in the app):');
eq('240 ml', 240);
eq('1 l', 1000);

console.log('imperial:');
eq('1.5 oz', 42.5);
eq('2 ounces', 56.7);

console.log('household measure restated in metric — the metric one wins:');
// "2 cookies (30 g)" is 30 g per serving, NOT 2. Taking the first number would
// scale every macro by 15x.
eq('2 cookies (30 g)', 30);
eq('1 cup (240 ml)', 240);
eq('2 tbsp (32g)', 32);
eq('3 pieces (45 g)', 45);

console.log('nothing usable -> null (fall back to grams):');
eq('1 bar', null);          // no metric amount at all
eq('1 slice', null);
eq('', null);
eq('   ', null);
eq(null, null);
eq(undefined, null);
eq(42, null);               // not a string
eq('per serving', null);

console.log('label noise is rejected rather than trusted:');
eq('2500 g', null);         // beyond any plausible single serving
eq('0 g', null);

console.log('\nsanity: a serving weight is only ever used when it parsed');
if (parseServingSize('2 cookies (30 g)') !== 30) { console.error('  FAIL parenthesised preference'); failures++; }

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall serving-size checks passed');
process.exit(failures ? 1 : 0);
