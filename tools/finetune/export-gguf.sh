#!/usr/bin/env bash
# Merged-HF-checkpoint → GGUF + mmproj → quantized deployment artifacts.
#
#   bash tools/finetune/export-gguf.sh runs/<name>/merged macrotrack-estimator
#
# Produces in models/:
#   <name>-f16.gguf            full-precision text model (eval reference)
#   mmproj-<name>-f16.gguf     vision projector (not quantized — it's small
#                              and projector quality matters)
#   <name>-q4_k_m.gguf         deployment quant (llama.rn)
#   <name>-q5_k_m.gguf         comparison quant
set -euo pipefail

MERGED="$1"
NAME="${2:-macrotrack-estimator}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
LLAMA="/home/jonathan.steffens/sglang_env/llama.cpp"
PY="$HERE/.venv-ft/bin/python"
OUT="$HERE/models"
mkdir -p "$OUT"

echo "== text model → f16 GGUF =="
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outfile "$OUT/$NAME-f16.gguf" --outtype f16

echo "== vision projector → mmproj GGUF =="
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outfile "$OUT/mmproj-$NAME-f16.gguf" --mmproj

echo "== quantize =="
"$LLAMA/build-cuda/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-q4_k_m.gguf" Q4_K_M
"$LLAMA/build-cuda/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-q5_k_m.gguf" Q5_K_M

ls -la "$OUT/$NAME"* "$OUT/mmproj-$NAME"*
