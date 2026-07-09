// Audit the branded restaurant rows in foods.db for resolution hazards like the
// "taco bell soft taco → Breakfast Soft Taco" bug: cases where the app's
// shortest-name search returns a semantically different row than a natural user
// query intends, plus portion/energy sanity checks.
//
//   node tools/db/audit-branded.mjs
//
// Checks:
//  1. SELF-RESOLUTION — every branded row's own name must resolve back to
//     itself (else it's shadowed by a shorter row and unreachable).
//  2. SIGNATURE QUERIES — natural queries for well-known items must hit the
//     expected item (not a qualifier variant like "breakfast"/"spicy"/"fresco").
//  3. GENERIC HIJACK — plain generic queries ("fries", "cheeseburger") that a
//     branded row wins over any generic; informational (may be acceptable).
//  4. PORTION/ENERGY SANITY — branded rows with implausible serving grams or
//     per-item kcal.
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', '..', 'mobile', 'assets', 'foods.db'), { readOnly: true });
const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);
const norm = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function search(q, n = 1) {
  const all = norm(q).split(' ').filter(Boolean);
  const toks = all.filter((t) => !STOP.has(t)).length ? all.filter((t) => !STOP.has(t)) : all;
  if (!toks.length) return [];
  const where = toks.map(() => "(' ' || name_norm) LIKE ?").join(' AND ');
  return db
    .prepare(`SELECT name, kcal, data_type, portions_json FROM foods WHERE ${where}
              ORDER BY CASE WHEN name_norm LIKE ? THEN 0 ELSE 1 END, LENGTH(name_norm) LIMIT ${n}`)
    .all(...toks.map((t) => `% ${t}%`), `${toks[0]}%`);
}
const itemKcal = (r) => {
  const p = JSON.parse(r.portions_json || '[]')[0];
  return p ? Math.round((r.kcal * p.grams) / 100) : null;
};

const branded = db.prepare("SELECT name, kcal, portions_json FROM foods WHERE data_type='branded'").all();
console.log(`auditing ${branded.length} branded rows\n`);

// ---- 1. self-resolution ----
let shadowed = [];
for (const r of branded) {
  const hit = search(r.name)[0];
  if (!hit || hit.name !== r.name) shadowed.push([r.name, hit?.name ?? 'NO MATCH']);
}
console.log(`1) SELF-RESOLUTION: ${branded.length - shadowed.length}/${branded.length} rows resolve to themselves`);
for (const [want, got] of shadowed.slice(0, 15)) console.log(`   SHADOWED: "${want}" → "${got}"`);
if (shadowed.length > 15) console.log(`   … +${shadowed.length - 15} more`);

// ---- 2. signature queries (expect substring; flag qualifier-variant wins) ----
const QUALIFIERS = /breakfast|spicy|fresco|supreme|deluxe|double|triple|jr|junior|little|kids|mini|bacon|cheese(?!burger)/i;
const SIGS = [
  ['mcdonalds big mac', 'big mac'], ['mcdonalds quarter pounder', 'quarter pounder'],
  ['mcdonalds fries', 'fries'], ['mcdonalds chicken nuggets', 'nugget'], ['mcdonalds mcchicken', 'mcchicken'],
  ['taco bell soft taco', 'soft taco'], ['taco bell crunchy taco', 'crunchy taco'],
  ['taco bell burrito supreme', 'burrito supreme'], ['taco bell quesadilla', 'quesadilla'],
  ['burger king whopper', 'whopper'], ['burger king fries', 'fries'], ['burger king chicken sandwich', 'chicken'],
  ['wendys baconator', 'baconator'], ['wendys frosty', 'frosty'], ['wendys spicy chicken sandwich', 'spicy chicken'],
  ['subway turkey sub', 'turkey'], ['subway meatball sub', 'meatball'],
  ['chipotle chicken burrito', 'burrito'], ['chipotle chicken bowl', 'bowl'],
  ['chick fil a chicken sandwich', 'chicken sandwich'], ['chick fil a nuggets', 'nugget'], ['chick fil a waffle fries', 'waffle'],
  ['kfc fried chicken', 'chicken'], ['kfc popcorn chicken', 'popcorn'],
  ['popeyes chicken sandwich', 'chicken'], ['panda express orange chicken', 'orange chicken'],
  ['panda express chow mein', 'chow mein'], ['panda express fried rice', 'fried rice'],
  ['five guys cheeseburger', 'cheeseburger'], ['five guys fries', 'fries'],
  ['dairy queen blizzard', 'blizzard'], ['sonic cheeseburger', 'cheeseburger'],
  ['dunkin donut', 'donut'], ['dunkin glazed donut', 'glazed'],
  ['dominos pepperoni pizza', 'pepperoni'], ['pizza hut pepperoni pizza', 'pepperoni'],
  ['papa johns pepperoni pizza', 'pepperoni'], ['little caesars pepperoni pizza', 'pepperoni'],
  ['starbucks caramel frappuccino', 'frappuccino'], ['arbys roast beef sandwich', 'roast beef'],
  ['jack in the box tacos', 'taco'], ['whataburger', 'whataburger'], ['culvers butterburger', 'butterburger'],
  ['in n out', null], ['panera mac and cheese', 'mac'],
];
console.log('\n2) SIGNATURE QUERIES (⚠ = miss/qualifier-variant win):');
let sigBad = 0;
for (const [q, expect] of SIGS) {
  const hit = search(q)[0];
  if (!hit) { console.log(`   ⚠ MISS       "${q}" → NO MATCH`); sigBad++; continue; }
  const kc = itemKcal(hit);
  const nameNoChain = hit.name.replace(/^[^ ]+ ?[^ ]*? /, '');
  const expectOk = expect === null || norm(hit.name).includes(norm(expect));
  const qualifierWin = expectOk && QUALIFIERS.test(nameNoChain) && !QUALIFIERS.test(q);
  if (!expectOk) { console.log(`   ⚠ WRONG      "${q}" → "${hit.name}" (${kc ?? '?'} kcal)`); sigBad++; }
  else if (qualifierWin) { console.log(`   ⚠ QUALIFIER  "${q}" → "${hit.name}" (${kc ?? '?'} kcal)`); sigBad++; }
  else console.log(`   ok           "${q}" → "${hit.name}" (${kc ?? '?'} kcal)`);
}

// ---- 3. generic hijack ----
console.log('\n3) GENERIC HIJACK (branded row wins a plain generic query):');
const GENERICS = ['soft taco', 'crunchy taco', 'fries', 'french fries', 'cheeseburger', 'hamburger',
  'chicken nuggets', 'chicken sandwich', 'pepperoni pizza', 'cheese pizza', 'milkshake', 'burrito',
  'quesadilla', 'onion rings', 'hash browns', 'fried chicken', 'roast beef sandwich', 'hot dog',
  'ice cream cone', 'donut'];
for (const q of GENERICS) {
  const hit = search(q)[0];
  if (hit && hit.data_type === 'branded') console.log(`   ⚠ "${q}" → "${hit.name}" (branded)`);
}

// ---- 4. portion/energy sanity ----
console.log('\n4) PORTION / ENERGY SANITY:');
let sane = 0;
for (const r of branded) {
  const p = JSON.parse(r.portions_json || '[]')[0];
  const kc = p ? Math.round((r.kcal * p.grams) / 100) : null;
  const bad = !p || p.grams < 20 || p.grams > 1200 || kc < 30 || kc > 2600;
  if (bad) console.log(`   ⚠ ${r.name.slice(0, 48).padEnd(48)} portion=${p?.grams ?? '—'}g item=${kc ?? '—'}kcal per100=${Math.round(r.kcal)}`);
  else sane++;
}
console.log(`   ${sane}/${branded.length} rows within sane bounds`);
console.log(`\nsummary: shadowed=${shadowed.length}, signature issues=${sigBad}`);
