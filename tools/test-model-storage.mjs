// Tests the on-device model pruning rule (mobile/src/lib/ai/model-storage.ts).
//
// This decides what gets DELETED from a user's phone after a model update, so
// the invariant that matters most is negative: the current tag's directory must
// never be returned. Returning it would delete the model that was just
// downloaded, leaving the app with no weights and a 529 MB re-download.
//
// Compiled with the project's own tsc and run under node — local-model.ts pulls
// in expo-file-system and cannot run here, which is why the rule lives in its
// own import-free module.
//
//   node tools/test-model-storage.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// .bin shims are not portably spawnable (Windows tsc.cmd + Node's
// CVE-2024-27980 hardening); go through node and the package entrypoint.
const TSC = join(ROOT, 'mobile/node_modules/typescript/bin/tsc');

const out = mkdtempSync(join(tmpdir(), 'mt-storage-'));
try {
  execFileSync(process.execPath, [
    TSC, join(ROOT, 'mobile/src/lib/ai/model-storage.ts'),
    '--outDir', out, '--module', 'esnext', '--target', 'es2022',
    '--moduleResolution', 'bundler', '--skipLibCheck',
  ], { stdio: 'pipe' });
} catch (e) {
  const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (!msg.includes('error TS')) { console.error(msg || e.message); process.exit(1); }
}
writeFileSync(join(out, 'package.json'), '{"type":"module"}');
const { stalePruneTargets } = await import(pathToFileURL(join(out, 'model-storage.js')).href);

let failures = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify([...got].sort());
  const w = JSON.stringify([...want].sort());
  if (g !== w) { console.error(`  FAIL ${label}: got ${g}, want ${w}`); failures++; }
};

const TAG = 'text-v3';
const GGUF = 'macrotrack-text-0.8b-q4_k_m.gguf';
const dir = (name) => ({ name, isDirectory: true });
const file = (name) => ({ name, isDirectory: false });

console.log('nothing to do:');
eq('fresh install', stalePruneTargets([], TAG), []);
eq('only the current tag', stalePruneTargets([dir(TAG)], TAG), []);

console.log('old releases are reclaimed:');
eq('previous tag alongside current', stalePruneTargets([dir('text-v2'), dir(TAG)], TAG), ['text-v2']);
eq('several old tags', stalePruneTargets([dir('text-v1'), dir('text-v2'), dir(TAG)], TAG), ['text-v1', 'text-v2']);
eq('old tag with no current yet', stalePruneTargets([dir('text-v2')], TAG), ['text-v2']);

console.log('the legacy untagged layout is swept up:');
// Pre-fix installs put the GGUF straight in documents/models/. It must go: it
// is the file that was being mistaken for an install of whatever tag is current.
eq('bare file beside the current tag', stalePruneTargets([file(GGUF), dir(TAG)], TAG), [GGUF]);
eq('bare file alone', stalePruneTargets([file(GGUF)], TAG), [GGUF]);
eq('bare file plus an old tag', stalePruneTargets([file(GGUF), dir('text-v2'), dir(TAG)], TAG), [GGUF, 'text-v2']);

console.log('the invariant — the current tag is never deleted:');
for (const entries of [
  [dir(TAG)],
  [dir(TAG), dir('text-v2')],
  [dir(TAG), file(GGUF)],
  [dir(TAG), file(GGUF), dir('text-v1'), dir('text-v2')],
]) {
  if (stalePruneTargets(entries, TAG).includes(TAG)) {
    console.error(`  FAIL current tag returned for ${JSON.stringify(entries)}`);
    failures++;
  }
}
// A FILE that happens to be named like the tag is still legacy junk: the current
// tag's files live one level down, inside a directory of that name.
eq('a file named like the tag is not the tag', stalePruneTargets([file(TAG)], TAG), [TAG]);

console.log('tag changes follow the constant:');
eq('under text-v2, v3 is the stale one', stalePruneTargets([dir('text-v2'), dir('text-v3')], 'text-v2'), ['text-v3']);

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall model-storage checks passed');
process.exit(failures ? 1 : 0);
