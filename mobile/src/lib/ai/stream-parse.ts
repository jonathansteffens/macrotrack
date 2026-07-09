/**
 * Partial-JSON scanner for the streaming estimator.
 *
 * The grammar-constrained model emits `{"items":[{...},{...},...],...}` with the
 * items in order, so as tokens stream in each item object closes long before the
 * whole claim does. This walks the (still-incomplete) buffer and returns every
 * item object that has already fully closed — string/escape-aware brace matching
 * inside the `items` array, so braces/brackets inside string values don't fool
 * the depth counter.
 *
 * Ported verbatim (behaviour-for-behaviour) from tools/chat/playground.mjs
 * `extractCompleteItems`, which was validated against the live llama-server SSE
 * stream. Keep the two in sync. Typed here for the RN app; the return element is
 * a raw parsed object (a partially-populated ClaimItem) — the caller reads only
 * the light fields (name/grams) it needs, since full resolution happens once at
 * the end.
 *
 * Self-check (informal unit test — run in a scratch node REPL if you touch this):
 *   const P = '{"items":[{"name":"a","grams":10},{"name":"b [x]","grams":20},{"na';
 *   extractCompleteItems(P) // => [{name:'a',grams:10},{name:'b [x]',grams:20}]
 *   //  ^ the trailing half-written 3rd object is correctly skipped, and the
 *   //    "]" inside "b [x]" does NOT prematurely close the array.
 *   extractCompleteItems('{"foo":1}')            // => []  (no items key yet)
 *   extractCompleteItems('{"items":[')           // => []  (array open, nothing closed)
 */
export function extractCompleteItems(buf: string): Record<string, unknown>[] {
  const key = buf.indexOf('"items"');
  if (key < 0) return [];
  const arrStart = buf.indexOf('[', key);
  if (arrStart < 0) return [];
  const items: Record<string, unknown>[] = [];
  let depth = 0,
    inStr = false,
    esc = false,
    objStart = -1;
  for (let i = arrStart + 1; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          items.push(JSON.parse(buf.slice(objStart, i + 1)) as Record<string, unknown>);
        } catch {
          /* incomplete/invalid — skip */
        }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) break; // items array closed
  }
  return items;
}
