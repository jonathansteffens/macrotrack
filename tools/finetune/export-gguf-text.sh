#!/bin/bash
# Convert a merged fp16 TEXT model to GGUF and quantize. Text-only successor to
# export-gguf.sh (which also built a vision mmproj). No mmproj here — the app is
# text-only. Quantizes to several levels so we can pick the smallest that holds
# quality (< 3 pts median APE vs f16); on-device decode is bandwidth-bound, so
# byte size ~ speed.
#
#   bash tools/finetune/export-gguf-text.sh <merged_dir> <out_basename> [QUANTS...]
#   bash tools/finetune/export-gguf-text.sh runs/text-0.8b/merged models/mt-text-0.8b Q4_K_M Q5_K_M Q6_K
set -euo pipefail
MERGED="$1"; OUTBASE="$2"; shift 2
QUANTS=("$@"); [ ${#QUANTS[@]} -eq 0 ] && QUANTS=(Q4_K_M Q5_K_M Q6_K Q3_K_M)
LLAMA=/home/jonathan.steffens/sglang_env/llama.cpp
PY=/home/jonathan.steffens/sglang_env/macrotrack/.venv-ft/bin/python
QUANTIZE="$LLAMA/build-cuda/bin/llama-quantize"

mkdir -p "$(dirname "$OUTBASE")"

# Force the embedded chat template to non-thinking (idempotent) so the deployed
# GGUF emits a closed empty <think></think> regardless of the runtime's
# reasoning setting — the model is trained non-thinking and decodes under a JSON
# grammar; leaving reasoning on "auto" returns empty content. Baking it here
# means the app needs no thinking config (only the 3 integration constants).
echo "=== force non-thinking chat template ==="
"$PY" "$(dirname "$0")/force_no_think.py" "$MERGED"

F16="${OUTBASE}-f16.gguf"
echo "=== convert $MERGED -> $F16 (f16) ==="
# --no-mtp: drop the multi-token-prediction head (blk.24). It's a speculative
# draft head we don't use, and the bundled form makes the loader expect a full
# decoder layer at blk.24 → "missing tensor blk.24.attn_norm.weight" on load.
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outfile "$F16" --outtype f16 --no-mtp

for q in "${QUANTS[@]}"; do
  OUT="${OUTBASE}-$(echo "$q" | tr 'A-Z' 'a-z').gguf"
  echo "=== quantize $q -> $OUT ==="
  "$QUANTIZE" "$F16" "$OUT" "$q"
done
echo "=== sizes ==="
ls -la "${OUTBASE}"*.gguf | awk '{print $5, $9}'
