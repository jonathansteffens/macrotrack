// Local chat playground for the MacroTrack text estimator. Runs the FULL app
// pipeline so you can stress-test the model and spot issues:
//   your text → (real frozen prompt + FoodClaim grammar via llama-server)
//   → FoodClaim JSON → resolve each item against foods.db → macros.
// Shows the matched DB food per item (or "est" fallback), per-item + total
// macros, clarifying questions, confidence, and the raw JSON — the same
// resolution the app does. Multi-turn: answer a clarifying question and the
// model re-emits the full claim.
//
//   node tools/chat/playground.mjs                       # llama-server on :8041
//   node tools/chat/playground.mjs --llama-url http://127.0.0.1:8033/v1 --port 8090
//
// Needs a llama-server running the estimator GGUF with --jinja (grammar comes
// from response_format json_schema). Open the printed URL in a browser
// (VS Code forwards the localhost port automatically).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT = parseInt(arg('port', '8090'), 10);
const LLAMA_URL = arg('llama-url', 'http://127.0.0.1:8041/v1');
const MODEL = arg('model', 'local');

// ---- frozen prompt + schema from source (single source of truth) ----
const SYSTEM_PROMPT = readFileSync(join(ROOT, 'mobile/src/lib/ai/prompt.ts'), 'utf8')
  .match(/ESTIMATOR_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
const SCHEMA = new Function(`return (${readFileSync(join(ROOT, 'mobile/src/lib/ai/schema.ts'), 'utf8')
  .match(/FOOD_CLAIM_SCHEMA = ({[\s\S]*?}) as const;/)[1]});`)();

// ---- foods.db resolution: identical to tools/eval/run-eval.mjs ----
const db = new DatabaseSync(join(ROOT, 'mobile/assets/foods.db'), { readOnly: true });
const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'in', 'on', 'or', 'for', 'to']);
function search(query, col = 'name_norm') {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const meaningful = all.filter((t) => !STOP.has(t));
  const tokens = meaningful.length ? meaningful : all;
  if (!tokens.length) return null;
  const where = tokens.map(() => `(' ' || ${col}) LIKE ? ESCAPE '\\'`).join(' AND ');
  const params = tokens.map((t) => `% ${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  // Mirrors mobile/src/lib/foods.ts 'all'/'display' scope: whole-word first, then
  // prefix, then shortest. col is name_norm for the primary pass and
  // display_name_norm for the strict-superset fallback (guarded to rows with one).
  const guard = col === 'display_name_norm' ? 'AND display_name_norm IS NOT NULL' : '';
  return db.prepare(
    `SELECT name, name_norm, kcal, protein, carbs, fat, data_type, portions_json FROM foods WHERE ${where} ${guard}
     ORDER BY CASE WHEN (' ' || ${col} || ' ') LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
              CASE WHEN ${col} LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(${col}) LIMIT 1`
  ).get(...params, `% ${tokens[0].replace(/[\\%_]/g, (c) => '\\' + c)} %`, `${tokens[0]}%`);
}
const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
function countInName(name) {
  const m = /^(\d{1,2})\s+/.exec((name || '').trim());
  if (m) return Math.min(24, parseInt(m[1], 10)) || null;
  return COUNT_WORDS[(name || '').trim().toLowerCase().split(/\s+/)[0]] ?? null;
}

// ---- Branded corroboration guard — keep IN SYNC across resolver.ts,
//   tools/eval/run-eval.mjs, tools/chat/playground.mjs,
//   tools/eval/adversarial/run.mjs ----
// A single generic search token can whole-word match a branded row by accident
// ("oreo" → "Dairy Queen Royal Oreo Blizzard"); branded serving-scaling would
// then multiply the model's count by that row's ~350 g serving ("4 oreos" →
// 1400 g / 4200 kcal). So branded serving-scaling applies ONLY when the match
// is CORROBORATED by the model's own words: it named the row's brand/chain, OR
// it named every one of the row's distinctive (product-identity) tokens.
// COMMON_BRAND_TOKENS = tokens in ≥ COMMON_DF_MIN branded name_norms — chain
// names (dairy, queen, burger, king, …) plus generic food words (sandwich,
// cheese, …); everything rarer is a distinctive token (baconator, whopper,
// blizzard, big, mac, …). Derived once from the bundled foods.db.
const COMMON_DF_MIN = 20;
function corrTokens(s) {
  return (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}
const COMMON_BRAND_TOKENS = (() => {
  const rows = db.prepare("SELECT name_norm FROM foods WHERE data_type = 'branded'").all();
  const df = new Map();
  for (const r of rows) for (const t of new Set(corrTokens(r.name_norm))) df.set(t, (df.get(t) || 0) + 1);
  const set = new Set();
  for (const [t, n] of df) if (n >= COMMON_DF_MIN) set.add(t);
  return set;
})();
function brandedCorroborated(item, rowNameNorm) {
  const modelToks = new Set([item.name, ...(item.db_search_terms || [])].flatMap(corrTokens));
  const rowToks = [...new Set(corrTokens(rowNameNorm))];
  const distinctive = rowToks.filter((t) => !COMMON_BRAND_TOKENS.has(t));
  const common = rowToks.filter((t) => COMMON_BRAND_TOKENS.has(t));
  const namedBrand = common.length > 0 && common.every((t) => modelToks.has(t));
  const namedProduct = distinctive.length > 0 && distinctive.every((t) => modelToks.has(t));
  return namedBrand || namedProduct;
}

function resolveItem(item) {
  const stripped = (item.name || '').replace(/^(\d{1,2}|[a-z]+)\s+/i, '');
  const terms = [...(item.db_search_terms || []), item.name];
  if (countInName(item.name) && stripped) terms.push(stripped);
  let food = null, via = null;
  for (const term of terms) {
    food = search(term);
    if (food) { via = term; break; }
  }
  // Stage 2 (STRICT SUPERSET) — only when name_norm matched NOTHING for every
  // term do we retry against the plain-language display_name_norm, so no
  // existing resolution can change (mirrors resolver.ts resolveItem; in sync
  // with tools/eval/run-eval.mjs and tools/eval/adversarial/run.mjs).
  if (!food) {
    for (const term of terms) {
      food = search(term, 'display_name_norm');
      if (food) { via = term; break; }
    }
  }
  const per100 = food ?? item.est_per100 ?? { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  // Mirrors resolver.ts seedGrams: v2 count preference (count × per-unit
  // serving) first, else branded → whole servings (explicit count in the name
  // wins, plural snaps model grams, else 1 item).
  let grams = item.grams || 0;
  // Branded serving-scaling only when the model's words corroborate the match
  // (see brandedCorroborated) — an uncorroborated branded row is a coincidental
  // token collision, so keep the model's own grams instead of snapping.
  const branded = food?.data_type === 'branded' && brandedCorroborated(item, food.name_norm);
  let brandedServing;
  if (branded) {
    // Multi-portion rows (FNDDS "Mac Jr"/"Big Mac"/"Grand Mac"): label match
    // to the claim name first, then closest grams — mirrors resolver.ts.
    const portions = JSON.parse(food.portions_json || '[]').filter((p) => p.grams > 0);
    const toks = (item.name || '').toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const sc = (l) => toks.filter((t) => (l || '').toLowerCase().includes(t)).length;
    brandedServing = portions.sort((a, b) => sc(b.label) - sc(a.label) || Math.abs(a.grams - grams) - Math.abs(b.grams - grams))[0]?.grams;
  }
  if (typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0) {
    // Stopgap for the "fake branded SKU" emission {name:"2 big mac", count:1}:
    // count stuck at 1 but the real count baked into the name — trust the
    // larger; a genuine count > 1 is untouched. (mirrors resolver.ts,
    // run-eval.mjs seedGrams — keep the three in sync.)
    const effCount = item.count === 1 ? Math.max(item.count, countInName(item.name) ?? 1) : item.count;
    const count = Math.min(24, Math.max(0.25, effCount));
    const serving = brandedServing && brandedServing > 0
      ? brandedServing
      : item.unit_grams && item.unit_grams > 0 ? item.unit_grams : grams / item.count;
    grams = Math.round(count * serving);
  } else if (branded && brandedServing > 0) {
    const explicit = countInName(item.name);
    const plural = /s$/i.test((item.name || '').trim());
    const count = explicit ?? (plural ? Math.min(24, Math.max(1, Math.round(grams / brandedServing))) : 1);
    grams = count * brandedServing;
  }
  const f = grams / 100;
  return {
    name: item.name, grams, prep: item.prep, confidence: item.confidence,
    searchTerms: item.db_search_terms || [], matched: food ? food.name : null, matchedVia: via,
    kcal: per100.kcal * f, protein: (per100.protein ?? 0) * f, carbs: (per100.carbs ?? 0) * f, fat: (per100.fat ?? 0) * f,
  };
}
function resolveClaim(claim) {
  const items = (claim.items || []).map(resolveItem);
  const totals = items.reduce((s, r) => ({ kcal: s.kcal + r.kcal, protein: s.protein + r.protein, carbs: s.carbs + r.carbs, fat: s.fat + r.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { items, totals, needs_clarification: !!claim.needs_clarification, questions: claim.questions || [], meal_guess: claim.meal_guess };
}

// ---- Streaming: extract COMPLETED item objects from a partial FoodClaim ----
// The grammar emits {"items":[{...},{...},...],...} in order, so as tokens
// stream in, each item object closes long before the claim does. This scanner
// (string/escape-aware brace matching inside the items array) is exactly the
// logic the app needs on llama.rn's onToken path to show items appearing live.
function extractCompleteItems(buf) {
  const key = buf.indexOf('"items"');
  if (key < 0) return [];
  const arrStart = buf.indexOf('[', key);
  if (arrStart < 0) return [];
  const items = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = arrStart + 1; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { items.push(JSON.parse(buf.slice(objStart, i + 1))); } catch { /* incomplete/invalid — skip */ }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) break; // items array closed
  }
  return items;
}

// Stream the model's tokens; invoke onItem(item, index) the moment each item
// object completes. Returns the full content + timings when generation ends.
async function callModelStream(messages, onItem) {
  const t0 = Date.now();
  const res = await fetch(`${LLAMA_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, temperature: 0, stream: true,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      response_format: { type: 'json_schema', json_schema: { name: 'food_claim', strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let content = '', timings = null, emitted = 0, sse = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    sse += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = sse.indexOf('\n')) >= 0) {
      const line = sse.slice(0, nl).trim();
      sse = sse.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      content += data.choices?.[0]?.delta?.content ?? '';
      if (data.timings) timings = data.timings;
      const done = extractCompleteItems(content);
      while (emitted < done.length) { onItem(done[emitted], emitted); emitted++; }
    }
  }
  return { content, timings, ms: Date.now() - t0 };
}

const HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MacroTrack estimator — playground</title>
<style>
  :root{--bg:#0f1216;--panel:#171b22;--panel2:#1e232c;--line:#2a313c;--fg:#e6e9ee;--dim:#9aa4b2;--accent:#5b9dff;--good:#3fb950;--warn:#d29922;--bad:#f85149}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column}
  header{padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  header b{font-size:15px}
  header .meta{color:var(--dim);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #dot{width:9px;height:9px;border-radius:50%;background:var(--warn)}
  #log{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:14px;max-width:920px;width:100%;margin:0 auto}
  .msg{max-width:100%}
  .user{align-self:flex-end;background:var(--accent);color:#fff;padding:8px 13px;border-radius:14px 14px 3px 14px;max-width:80%}
  .card{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:4px 14px 14px 14px;padding:12px 14px;width:100%}
  .row1{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .pill{font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:var(--panel2);color:var(--dim);padding:2px 8px;border-radius:20px}
  .kcal{font-size:22px;font-weight:700}
  .macros{color:var(--dim);font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:4px}
  th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .matched{color:var(--good)}
  .est{color:var(--warn)}
  .conf-lo{color:var(--bad)}
  tr.total td{border-top:2px solid var(--line);border-bottom:none;font-weight:700}
  .ask{background:rgba(210,153,34,.12);border:1px solid var(--warn);border-radius:8px;padding:8px 12px;margin:8px 0;color:#f0c674}
  .ask b{color:var(--warn)}
  details{margin-top:8px}summary{cursor:pointer;color:var(--dim);font-size:12px}
  pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto;font-size:12px;color:#cdd6e2}
  .err{color:var(--bad)}
  footer{padding:12px 16px;background:var(--panel);border-top:1px solid var(--line)}
  .inbar{display:flex;gap:8px;max-width:920px;margin:0 auto}
  textarea{flex:1;resize:none;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:inherit;min-height:44px;max-height:160px}
  button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:0 18px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
  button:disabled{opacity:.5;cursor:default}
  .hint{color:var(--dim);font-size:12px;text-align:center;margin-top:6px}
</style></head>
<body>
<header>
  <span id="dot"></span><b>MacroTrack estimator</b>
  <span class="meta" id="meta"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="reset">Reset chat</button>
</header>
<div id="log"></div>
<footer>
  <div class="inbar">
    <textarea id="in" placeholder="Describe a meal — e.g. 'one bratwurst with dijon mustard' … (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
  </div>
  <div class="hint">Runs the real prompt + FoodClaim grammar, then resolves against foods.db. <span class="est">amber</span> = no DB match (used the model's est_per100).</div>
</footer>
<script>
const log = document.getElementById('log'), input = document.getElementById('in'), sendBtn = document.getElementById('send');
let history = [];  // [{role, content}] — assistant content is the raw claim JSON
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const n = (x,d=0) => (x==null?'–':Number(x).toFixed(d));

fetch('/info').then(r=>r.json()).then(i=>{
  document.getElementById('meta').textContent = i.model + ' @ ' + i.llamaUrl;
  document.getElementById('dot').style.background = i.ok ? 'var(--good)' : 'var(--bad)';
});

function addUser(text){ const d=document.createElement('div'); d.className='msg user'; d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight; }
function addRaw(html){ const d=document.createElement('div'); d.className='msg card'; d.innerHTML=html; log.appendChild(d); log.scrollTop=log.scrollHeight; return d; }

function renderCard(r, meta){
  const rows = r.items.map(it => {
    const cls = it.matched ? 'matched' : 'est';
    const dbcell = it.matched ? esc(it.matched) : '<span class="est">no DB match — est</span>';
    const conf = it.confidence!=null ? '<span class="'+(it.confidence<0.6?'conf-lo':'')+'">'+n(it.confidence,2)+'</span>' : '–';
    return '<tr>'+
      '<td>'+esc(it.name)+(it.prep?' <span class="macros">('+esc(it.prep)+')</span>':'')+'</td>'+
      '<td class="num">'+n(it.grams)+'</td>'+
      '<td class="num">'+conf+'</td>'+
      '<td class="'+cls+'">'+dbcell+'</td>'+
      '<td class="num">'+n(it.kcal)+'</td>'+
      '<td class="num">'+n(it.protein,1)+'</td>'+
      '<td class="num">'+n(it.carbs,1)+'</td>'+
      '<td class="num">'+n(it.fat,1)+'</td></tr>';
  }).join('');
  const t=r.totals;
  const ask = r.needs_clarification && r.questions.length
    ? '<div class="ask"><b>Asks:</b> '+r.questions.map(esc).join('<br>')+'</div>' : '';
  return '<div class="row1"><span class="pill">'+esc(r.meal_guess||'?')+'</span>'+
      '<span class="kcal">'+n(t.kcal)+' kcal</span>'+
      '<span class="macros">P '+n(t.protein,1)+'g · C '+n(t.carbs,1)+'g · F '+n(t.fat,1)+'g</span>'+
      '<span style="flex:1"></span><span class="macros">'+meta+'</span></div>'+
    ask+
    '<table><thead><tr><th>item</th><th class="num">g</th><th class="num">conf</th><th>DB match</th><th class="num">kcal</th><th class="num">P</th><th class="num">C</th><th class="num">F</th></tr></thead><tbody>'+
    rows+'<tr class="total"><td>total</td><td></td><td></td><td></td><td class="num">'+n(t.kcal)+'</td><td class="num">'+n(t.protein,1)+'</td><td class="num">'+n(t.carbs,1)+'</td><td class="num">'+n(t.fat,1)+'</td></tr></tbody></table>'+
    '<details><summary>search terms &amp; raw claim</summary><pre>'+esc(JSON.stringify(r.claim,null,2))+'</pre></details>';
}

function liveItemLine(it){
  const db = it.matched ? '<span class="matched">'+esc(it.matched)+'</span>' : '<span class="est">est</span>';
  return '<div>◦ '+esc(it.name)+' '+n(it.grams)+'g → '+db+' <span class="macros">'+n(it.kcal)+' kcal</span></div>';
}
async function send(){
  const text = input.value.trim(); if(!text) return;
  input.value=''; input.style.height='auto'; sendBtn.disabled=true;
  addUser(text);
  history.push({role:'user', content:text});
  const pending = addRaw('<span class="macros">thinking…</span>');
  let liveHtml = '';
  try{
    // consume the SSE stream: items render the moment the model finishes each one
    const res = await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:history})});
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf='', finished=false;
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true});
      let idx;
      while((idx = buf.indexOf('\\n\\n')) >= 0){
        const frame = buf.slice(0, idx); buf = buf.slice(idx+2);
        if(!frame.startsWith('data:')) continue;
        const data = JSON.parse(frame.slice(5));
        if(data.type === 'item'){
          liveHtml += liveItemLine(data.item);
          pending.innerHTML = liveHtml + '<span class="macros">…</span>';
          log.scrollTop = log.scrollHeight;
        } else if(data.type === 'done'){
          const meta = Math.round(data.ms)+' ms · '+(data.tokPerSec?data.tokPerSec.toFixed(0)+' tok/s':'');
          pending.innerHTML = renderCard(Object.assign(data.resolved,{claim:data.claim}), meta);
          history.push({role:'assistant', content:data.rawContent});
          finished = true;
        } else if(data.type === 'error'){
          pending.innerHTML = '<span class="err">'+esc(data.error)+'</span>'; history.pop(); finished = true;
        }
      }
    }
    if(!finished){ pending.innerHTML = '<span class="err">stream ended unexpectedly</span>'; history.pop(); }
  }catch(e){ pending.innerHTML='<span class="err">'+esc(e.message)+'</span>'; history.pop(); }
  sendBtn.disabled=false; input.focus(); log.scrollTop = log.scrollHeight;
}
sendBtn.onclick=send;
input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
input.addEventListener('input',()=>{ input.style.height='auto'; input.style.height=Math.min(160,input.scrollHeight)+'px'; });
document.getElementById('reset').onclick=()=>{ history=[]; log.innerHTML=''; input.focus(); };
input.focus();
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return;
    }
    if (req.method === 'GET' && req.url === '/info') {
      let ok = false;
      try { ok = (await fetch(`${LLAMA_URL.replace(/\/v1$/, '')}/health`)).ok; } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: MODEL, llamaUrl: LLAMA_URL, ok })); return;
    }
    if (req.method === 'POST' && req.url === '/chat') {
      let body = ''; for await (const c of req) body += c;
      const { messages } = JSON.parse(body);
      // SSE stream to the browser: an "item" event per completed+resolved item
      // (this is the streaming-UX prototype for the app), then a "done" event
      // with the full resolved claim.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      let out;
      try {
        out = await callModelStream(messages, (item, index) => send({ type: 'item', index, item: resolveItem(item) }));
      } catch (e) { send({ type: 'error', error: e.message }); res.end(); return; }
      let claim;
      try { claim = JSON.parse(out.content); }
      catch { send({ type: 'error', error: 'Model returned non-JSON: ' + String(out.content).slice(0, 300) }); res.end(); return; }
      send({ type: 'done', claim, resolved: resolveClaim(claim), rawContent: out.content, ms: out.ms, tokPerSec: out.timings?.predicted_per_second ?? null });
      res.end();
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  MacroTrack estimator playground → http://localhost:${PORT}`);
  console.log(`  model endpoint: ${LLAMA_URL}  (start llama-server with the GGUF + --jinja)\n`);
});
