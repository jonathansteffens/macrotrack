// Proves the app's quantity grammar and the tools' copy agree.
//
// mobile/src/lib/ai/quantity.ts (ships) and tools/parse/quantity.mjs (what the
// eval harnesses run) are necessarily separate files — the RN bundler cannot
// import from tools/, and node cannot import TypeScript. Everything the gate
// claims about app behaviour depends on them being the same grammar, so this
// compiles the TS copy and replays BOTH over every real input we have: the 151
// adversarial cases, the 55 in-dist eval cases, and the unit-test vectors.
//
//   node tools/parse/parity-check.mjs
//
// Run it after touching either grammar. A divergence here means the gate is no
// longer measuring what ships.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuantity as parseTools } from './quantity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TSC = join(ROOT, 'mobile/node_modules/.bin/tsc');

// Transpile the shipping grammar to ESM in a temp dir (no type-checking: that
// is `expo lint` / tsc's job, and quantity.ts has no imports to resolve).
const out = mkdtempSync(join(tmpdir(), 'mt-parity-'));
try {
  execFileSync(TSC, [
    join(ROOT, 'mobile/src/lib/ai/quantity.ts'),
    '--outDir', out, '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck',
  ], { stdio: 'pipe' });
} catch (e) {
  // tsc exits non-zero on type errors but still emits; only a missing file is fatal.
  const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (!msg.includes('error TS')) { console.error(msg || e.message); process.exit(1); }
  console.warn('tsc reported diagnostics (emit continued):\n' + msg.split('\n').slice(0, 5).join('\n'));
}
const emitted = join(out, 'quantity.js');
writeFileSync(join(out, 'package.json'), '{"type":"module"}');
const { parseQuantity: parseApp } = await import(`file://${emitted}`);

// ---- corpus: every real input available, plus the unit-test vectors --------
const texts = new Set();
for (const tag of ['v8', 'v9', 'v10']) {
  try {
    for (const r of JSON.parse(readFileSync(join(ROOT, `runs/adversarial/${tag}-q4.json`), 'utf8'))) {
      if (r.text) texts.add(r.text);
    }
  } catch { /* a revision may not have been gated */ }
}
try {
  for (const l of readFileSync(join(ROOT, 'tools/eval/cases.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const c = JSON.parse(l);
    if (c.text || c.input) texts.add(c.text ?? c.input);
  }
} catch { /* optional */ }
for (const t of [
  'a pound of ground beef', '2 lbs of shrimp', 'a half pound turkey burger patty',
  'half a dozen bagels', 'a half dozen doughnuts', 'a dozen dumplings',
  '20 chicken nuggets', 'two beers', '5 slices of pepperoni pizza',
  'a quarter of the lasagna', 'half a pizza', 'a whole rotisserie chicken',
  'three cups of air-popped popcorn', '12 fl oz of orange juice',
  'two scrambled eggs and a slice of whole wheat toast', 'like 3-4 tacos ish',
  'some chicken', 'a burger', 'for lunch I had 20 chicken nuggets', '',
]) texts.add(t);

let mismatches = 0;
for (const t of texts) {
  const a = parseApp(t);
  const b = parseTools(t);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    mismatches++;
    console.error(`  MISMATCH ${JSON.stringify(t)}\n    app  : ${JSON.stringify(a)}\n    tools: ${JSON.stringify(b)}`);
  }
}
rmSync(out, { recursive: true, force: true });

console.log(mismatches
  ? `\n${mismatches} MISMATCH(ES) across ${texts.size} inputs — the gate no longer predicts app behaviour`
  : `grammars agree on all ${texts.size} inputs`);
process.exit(mismatches ? 1 : 0);
