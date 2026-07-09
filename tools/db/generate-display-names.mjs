// Generate friendly display names for the curated (common=1) tier of foods.db.
// USDA canonical names read like lab specimens ("Chicken, broilers or fryers,
// breast, meat only, cooked, roasted"); this produces a consumer-facing layer
// ("Chicken breast, roasted") via an OPEN model on llama-server, with the
// canonical name kept for trust/search.
//
// DISPLAY-ONLY: search and the AI's db_search_terms keep targeting name_norm of
// the canonical name — this never touches the search index, or the estimator's
// DB-match rate would crater.
//
// Output: tools/db-data/display-names.json (canonical name → display name),
// which survives DB rebuilds; --apply also writes a display_name column into
// mobile/assets/foods.db for immediate use (build-food-db.mjs should re-apply
// the JSON on future rebuilds).
//
//   node tools/db/generate-display-names.mjs --llama-url http://127.0.0.1:8034/v1 \
//     [--limit 20] [--concurrency 8] [--apply]
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DB_PATH = join(ROOT, 'mobile', 'assets', 'foods.db');
const OUT_PATH = join(ROOT, 'tools', 'db-data', 'display-names.json');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const LLAMA_URL = arg('llama-url', 'http://127.0.0.1:8034/v1');
const LIMIT = parseInt(arg('limit', '0'), 10);       // 0 = all common rows
const CONCURRENCY = parseInt(arg('concurrency', '8'), 10);
const APPLY = process.argv.includes('--apply');

const SYSTEM = `You rewrite USDA food database names into short, natural names a consumer app can display. Rules:
- Keep every nutritionally meaningful qualifier: cooked vs raw, fat level (e.g. 85% lean, nonfat, 2%), preparation (roasted, fried, boiled), with/without skin or salt when present.
- Drop bureaucratic noise: "broilers or fryers", "commercially prepared", "mature seeds", "all commercial varieties", "year round average", "NFS", "(includes foods for USDA's Food Distribution Program)".
- Natural word order ("Roasted chicken breast" or "Chicken breast, roasted" — not "Chicken, broilers or fryers, breast").
- Brand names stay (e.g. "TACO BELL" → "Taco Bell").
- Max 45 characters. Sentence case (capitalize first word and proper nouns only).
Reply with ONLY the rewritten name, nothing else.`;

const db = new DatabaseSync(DB_PATH);
// --all: every row (full plain-language pass); default: the curated common tier.
const ALL = process.argv.includes('--all');
const rows = db.prepare(`SELECT id, name FROM foods ${ALL ? '' : 'WHERE common = 1 '}ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`).all();
console.log(`${rows.length} common-tier foods to name (of ${db.prepare('SELECT COUNT(*) c FROM foods').get().c} total)`);

// resume: keep already-generated names across runs
const existing = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : {};
const todo = rows.filter((r) => !existing[r.name]);
console.log(`${Object.keys(existing).length} already done, ${todo.length} to generate`);

function validate(canonical, name) {
  if (!name) return null;
  name = name.replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 48 || /\n/.test(name)) return null;
  if (/rewritten|display name|cannot|sorry/i.test(name)) return null;   // model chatter
  return name;
}

let done = 0, failed = 0;
async function nameOne(row) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${LLAMA_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'namer', max_tokens: 40, temperature: attempt ? 0.4 : 0,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: row.name }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = validate(row.name, (await res.json()).choices?.[0]?.message?.content?.trim());
      if (name) { existing[row.name] = name; return; }
    } catch { /* retry once */ }
  }
  failed++;
}

let next = 0;
async function worker() {
  while (next < todo.length) {
    const i = next++;
    await nameOne(todo[i]);
    if (++done % 100 === 0) {
      console.log(`  ${done}/${todo.length} (${failed} failed)`);
      mkdirSync(dirname(OUT_PATH), { recursive: true });
      writeFileSync(OUT_PATH, JSON.stringify(existing, null, 1));  // checkpoint
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(existing, null, 1));
console.log(`wrote ${Object.keys(existing).length} names → ${OUT_PATH} (${failed} failed, keep canonical)`);

// sample for spot-checking
for (const r of rows.slice(0, 12)) if (existing[r.name]) console.log(`  "${r.name}" → "${existing[r.name]}"`);

if (APPLY) {
  const cols = db.prepare(`PRAGMA table_info(foods)`).all().map((c) => c.name);
  if (!cols.includes('display_name')) db.exec(`ALTER TABLE foods ADD COLUMN display_name TEXT`);
  const upd = db.prepare(`UPDATE foods SET display_name = ? WHERE name = ?`);
  let n = 0;
  for (const [canonical, display] of Object.entries(existing)) { upd.run(display, canonical); n++; }
  console.log(`applied ${n} display names to ${DB_PATH} (column: display_name)`);
}
