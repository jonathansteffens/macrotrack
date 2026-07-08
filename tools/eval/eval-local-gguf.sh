#!/bin/bash
# Evaluate a local GGUF end-to-end on the FoodClaim text cases: serve it with
# llama-server (grammar via response_format json_schema, non-thinking), run the
# acceptance harness, and add the two metrics run-eval.mjs doesn't print —
# MEDIAN kcal APE (the honest headline; mean is popcorn-outlier-dominated) and
# decode tok/s (the whole point of going small).
#
#   bash tools/eval/eval-local-gguf.sh <model.gguf> <label> [gpu] [port]
set -uo pipefail
GGUF="$1"; LABEL="$2"; GPU="${3:-1}"; PORT="${4:-8033}"
ROOT=/home/jonathan.steffens/sglang_env/macrotrack
BIN=/home/jonathan.steffens/sglang_env/llama.cpp/build-cuda/bin/llama-server
export PATH="$HOME/.local/node/bin:$PATH"
OUT="$ROOT/runs/text-eval/${LABEL}.json"
mkdir -p "$ROOT/runs/text-eval"
LOG=$(mktemp)

CUDA_VISIBLE_DEVICES="$GPU" nohup "$BIN" -m "$GGUF" --host 127.0.0.1 --port "$PORT" \
  -ngl 99 -c 4096 -fa on --jinja -rea off > "$LOG" 2>&1 &
SRV=$!
for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health 2>/dev/null)" = "200" ] && break
  grep -q "loading error" "$LOG" 2>/dev/null && { echo "LOAD FAILED for $GGUF"; tail -5 "$LOG"; kill $SRV 2>/dev/null; exit 1; }
  sleep 2
done

# decode tok/s (single-stream, ungrammar'd, ~200 tokens)
TOKS=$(curl -s http://127.0.0.1:$PORT/completion -H 'content-type: application/json' \
  -d '{"prompt":"Emit a long JSON object describing a big dinner with many items:","n_predict":200,"temperature":0,"cache_prompt":false}' \
  | python3 -c 'import sys,json;print(round(json.load(sys.stdin).get("timings",{}).get("predicted_per_second",0),1))' 2>/dev/null)

node "$ROOT/tools/eval/run-eval.mjs" --base-url "http://127.0.0.1:$PORT/v1" --model "$LABEL" \
  --concurrency 4 --out "$OUT" 2>/dev/null | tail -8

# median / p90 APE from the saved rows
python3 - "$OUT" "$LABEL" "$TOKS" <<'PY'
import sys, json
out, label, toks = sys.argv[1], sys.argv[2], sys.argv[3]
j = json.load(open(out))
apes = sorted(r["kcalApe"] for r in j["rows"] if r.get("valid"))
def pct(p):
    if not apes: return float("nan")
    return apes[min(len(apes)-1, int(p*len(apes)))]
med = apes[len(apes)//2] if apes else float("nan")
s = j["summary"]
print(f"\n==== {label} ====")
print(f"  JSON validity : {s['jsonValidity']*100:.0f}%")
print(f"  median APE    : {med*100:.1f}%   (mean {s['kcalMape']*100:.1f}%, p90 {pct(0.9)*100:.1f}%)")
print(f"  protein MAE   : {s['proteinMae']:.1f} g")
print(f"  item acc      : {s['itemCountAcc']*100:.0f}%")
print(f"  DB match      : {s['dbMatchRate']*100:.0f}%")
print(f"  over-asking   : {s['clarificationRate']*100:.0f}%")
print(f"  decode tok/s  : {toks}")
# stash median+toks back into the file for the report
s["medianApe"] = med; s["decodeToksPerSec"] = float(toks) if toks else None
json.dump(j, open(out,"w"), indent=2)
PY

kill $SRV 2>/dev/null
rm -f "$LOG"
