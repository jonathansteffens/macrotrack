// Curate MenuStat annual data into a small, clutter-free set of branded
// restaurant menu items for foods.db. MenuStat is comprehensive (71k rows / 96
// chains) but bloated with every soda size, every topping, and every
// customizable build. We keep only what people actually LOG: the named entrees,
// sandwiches, sides, and signature caloric drinks — one representative size
// each, capped per chain. Output is a foods.db-ready JSON (per-100 g macros +
// a "1 item" portion); a separate merge step inserts it.
//
//   node tools/db/curate-fastfood.mjs <menustat.tab> [--cap 30] [--out tools/db-data/fastfood-curated.json]
//
// Source: MenuStat Annual Data, Harvard Dataverse doi:10.7910/DVN/K4NYTR (2018).
// Numbers are authoritative (chain-published); never LLM-generated.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const SRC = process.argv[2];
const CAP = parseInt(arg('cap', '30'), 10);          // max items per chain
const OUT = arg('out', join(ROOT, 'tools', 'db-data', 'fastfood-curated.json'));
if (!SRC) { console.error('usage: curate-fastfood.mjs <menustat.tab>'); process.exit(1); }

// Real restaurants people order from (MenuStat exact names → clean display prefix).
// Convenience stores (Wawa/Sheetz — thousands of deli SKUs) deliberately excluded.
const CHAINS = {
  "McDonald's": "McDonald's", "Burger King": "Burger King", "Wendy's": "Wendy's",
  "Taco Bell": "Taco Bell", "Subway": "Subway", "Chick-Fil-A": "Chick-fil-A",
  "KFC": "KFC", "Popeyes": "Popeyes", "Popeyes Louisiana Kitchen": "Popeyes",
  "Chipotle": "Chipotle", "Chipotle Mexican Grill": "Chipotle", "Starbucks": "Starbucks",
  "Dunkin' Donuts": "Dunkin'", "Dominos": "Domino's", "Domino's Pizza": "Domino's",
  "Pizza Hut": "Pizza Hut", "Papa John's": "Papa John's", "Sonic": "Sonic",
  "Sonic Drive-In": "Sonic", "Arby's": "Arby's", "Jack in the Box": "Jack in the Box",
  "Dairy Queen": "Dairy Queen", "Panera Bread": "Panera", "Chili's": "Chili's",
  "Applebee's": "Applebee's", "IHOP": "IHOP", "Denny's": "Denny's",
  "Olive Garden": "Olive Garden", "Buffalo Wild Wings": "Buffalo Wild Wings",
  "Five Guys": "Five Guys", "Whataburger": "Whataburger", "Culver's": "Culver's",
  "Panda Express": "Panda Express", "Jersey Mike's Subs": "Jersey Mike's",
  "Firehouse Subs": "Firehouse Subs", "Zaxby's": "Zaxby's", "Bojangles": "Bojangles",
  "Wingstop": "Wingstop", "Del Taco": "Del Taco", "Jimmy John's": "Jimmy John's",
  "White Castle": "White Castle", "Raising Cane's": "Raising Cane's",
  "Little Caesars": "Little Caesars", "Carl's Jr.": "Carl's Jr.", "Hardee's": "Hardee's",
  "Red Robin": "Red Robin", "Texas Roadhouse": "Texas Roadhouse",
};

// Food categories worth logging (in priority order for the per-chain cap).
const CAT_PRIORITY = ['Burgers', 'Sandwiches', 'Entrees', 'Pizza', 'Tacos', 'Salads',
  'Fried Potatoes', 'Appetizers & Sides', 'Soups', 'Baked Goods', 'Desserts', 'Beverages'];
const KEEP_CATS = new Set(CAT_PRIORITY);
// Beverages are mostly soda-size clutter; keep only caloric signature drinks.
const BEV_KEEP = /shake|malt|frappuccino|frappe|latte|mocha|smoothie|frosty|blizzard|float|milkshake|hot chocolate|macchiato|cappuccino|slush|freeze|concrete/i;
// Size/qualifier suffix to strip so variants collapse to one item.
const SIZE_RE = /,?\s*\(?(x-?small|small|medium|large|kids?|regular|mini|junior|jr\.?|snack size|value|sm|md|lg|xl|\d+\s*(oz|piece|pc|ct|count))\b\)?\.?\s*$/i;

const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

// MenuStat's Dataverse .tab wraps every field in double quotes ("Applebee's",
// "16 oz") and doubles internal quotes — strip that back to the raw value.
const unquote = (s) => {
  s = (s ?? '').trim();
  return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1).replace(/""/g, '"') : s;
};
const lines = readFileSync(SRC, 'utf8').split('\n').filter(Boolean);
const header = lines[0].split('\t').map(unquote);
const col = (name) => header.indexOf(name);
// Use PER-SERVING nutrient columns (far better populated than the _100g ones —
// e.g. McDonald's has calories on 271/274 rows but a gram weight on only 3), and
// derive per-100g from per-serving ÷ serving grams. Keeps the app's gram-scaling
// exact while recovering the big chains that lack listed serving weights.
const C = {
  rest: col('Restaurant'), cat: col('Food_Category'), name: col('Item_Name'),
  build: col('Customizable_Builds'), ssize: col('Serving_Size'), sunit: col('Serving_Size_Unit'),
  kcal: col('Calories'), fat: col('Total_Fat'), sat: col('Saturated_Fat'), chol: col('Cholesterol'),
  sod: col('Sodium'), pot: col('Potassium'), carb: col('Carbohydrates'), prot: col('Protein'),
  sug: col('Sugar'), fib: col('Dietary_Fiber'),
};
// When a serving weight is missing, estimate grams from a per-category kcal
// density. Per-ITEM macros stay exact (straight from MenuStat's per-serving
// numbers); only the 100 g basis is approximate. e.g. a 540-kcal burger ÷ 250 ×
// 100 ≈ 216 g (a Big Mac is ~211 g — close enough for gram-scaling).
const DENSITY = { Burgers: 250, Sandwiches: 235, Entrees: 190, Pizza: 265, Tacos: 210,
  Salads: 110, 'Fried Potatoes': 315, 'Appetizers & Sides': 245, Soups: 65,
  'Baked Goods': 360, Desserts: 300, Beverages: 50 };

const byChain = new Map();          // prefix -> Map(basename -> [candidate rows])
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split('\t').map(unquote);
  const prefix = CHAINS[f[C.rest]];
  if (!prefix) continue;                                   // chain not in allowlist
  if ((f[C.build] || '').trim() !== '') continue;          // base items only (no builds/add-ons)
  const cat = f[C.cat];
  if (!KEEP_CATS.has(cat)) continue;                       // drop Toppings & Ingredients etc.
  const kcalServ = num(f[C.kcal]);
  if (kcalServ == null || kcalServ <= 0) continue;         // need per-serving energy
  let g = num(f[C.ssize]);
  if (g != null && (f[C.sunit] || '').toLowerCase().startsWith('oz')) g *= 28.3495;
  let estimated = false;
  if (g == null || g < 5 || g > 2000) { g = (kcalServ / (DENSITY[cat] || 200)) * 100; estimated = true; }
  g = Math.min(1500, Math.max(15, g));
  const item = (f[C.name] || '').trim();
  if (cat === 'Beverages' && !BEV_KEEP.test(item)) continue; // drop soda-size explosion
  // Collapse customization permutations ("Whopper w/ Cheese & Mayo" → "Whopper")
  // to the base item; keep meaningful variants like "Double Whopper".
  const base = item.replace(/\s+w\/\s+.*$/i, '').replace(SIZE_RE, '').replace(/,\s*$/, '').trim();
  if (!base) continue;
  const per100 = (v) => { const x = num(v); return x == null ? null : Math.round((x / g) * 1000) / 10; };
  const row = {
    prefix, category: cat, item: base, grams: Math.round(g), estimated,
    kcal: Math.round((kcalServ / g) * 100),
    protein: per100(f[C.prot]), carbs: per100(f[C.carb]), fat: per100(f[C.fat]),
    fiber: per100(f[C.fib]), sugar: per100(f[C.sug]), sodium_mg: per100(f[C.sod]),
    sat_fat: per100(f[C.sat]), cholesterol_mg: per100(f[C.chol]), potassium_mg: per100(f[C.pot]),
  };
  if (!byChain.has(prefix)) byChain.set(prefix, new Map());
  const m = byChain.get(prefix);
  if (!m.has(base)) m.set(base, []);
  m.get(base).push(row);
}

// Collapse size variants: one representative per (chain, base) = median-calorie row.
// Then cap per chain by category priority.
const out = [];
const perChain = [];
for (const [prefix, m] of byChain) {
  const items = [];
  for (const [, variants] of m) {
    variants.sort((a, b) => a.kcal * a.grams - b.kcal * b.grams);
    items.push(variants[Math.floor(variants.length / 2)]);   // typical size
  }
  items.sort((a, b) => CAT_PRIORITY.indexOf(a.category) - CAT_PRIORITY.indexOf(b.category));
  const kept = items.slice(0, CAP);
  perChain.push([prefix, m.size, kept.length]);
  for (const r of kept) {
    out.push({
      name: `${r.prefix} ${r.item}`.replace(/\s+/g, ' ').trim(),
      category: `Restaurant — ${r.prefix}`,
      data_type: 'branded',
      kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber,
      sugar: r.sugar, sodium_mg: r.sodium_mg, sat_fat: r.sat_fat,
      cholesterol_mg: r.cholesterol_mg, calcium_mg: null, iron_mg: null, potassium_mg: r.potassium_mg,
      portions: [{ label: '1 item', grams: r.grams }],
      grams_estimated: r.estimated,   // true = serving weight estimated from kcal density (per-item macros still exact)
    });
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));

// ---- preview ----
console.log(`\nallowlist chains PRESENT in source: ${[...new Set(Object.values(CHAINS))].filter((p) => byChain.has(p)).length}/${new Set(Object.values(CHAINS)).size}`);
const missing = [...new Set(Object.values(CHAINS))].filter((p) => !byChain.has(p));
if (missing.length) console.log(`  not in MenuStat: ${missing.join(', ')}`);
const estN = out.filter((r) => r.grams_estimated).length;
console.log(`\ncurated ${out.length} items across ${perChain.length} chains (cap ${CAP}/chain) → ${OUT}`);
console.log(`  ${estN}/${out.length} have an estimated serving weight (per-item macros still exact); ${out.length - estN} have a listed weight`);
perChain.sort((a, b) => b[2] - a[2]);
console.log('\n  chain            raw→kept');
for (const [p, raw, kept] of perChain) console.log(`  ${p.padEnd(20)} ${String(raw).padStart(4)}→${kept}`);
console.log('\n  sample items:');
for (const r of out.filter((x) => /Big Mac|Whopper|Baconator|Crunchy Taco|Burrito Bowl|Frosty|Blizzard|Original Chicken Sandwich|Latte/i.test(x.name)).slice(0, 12))
  console.log(`   ${r.name.padEnd(42)} ${Math.round(r.kcal * r.portions[0].grams / 100)}kcal/item (${r.portions[0].grams}g, ${r.kcal}/100g)`);
