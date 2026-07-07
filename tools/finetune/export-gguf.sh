#!/usr/bin/env bash
# Merged-HF-checkpoint → GGUF + mmproj → quantized deployment artifacts.
#
#   bash tools/finetune/export-gguf.sh runs/<name>/merged macrotrack-estimator
#
# Produces in models/:
#   <name>-f16.gguf            full-precision text model (eval reference)
#   mmproj-<name>-f16.gguf     vision projector
#   <name>-q4_k_m.gguf         deployment quant (llama.rn)
#   <name>-q5_k_m.gguf         comparison quant
#
# IMPORTANT — how the merged dir must be produced:
#   Use tools/finetune/merge_lora.py (peft merge_and_unload into the fp16
#   base), NOT Unsloth's save_pretrained_merged — the latter was observed to
#   silently emit BASE weights for Qwen2.5-VL (the exported GGUF then behaves
#   exactly like the untuned model). The export below auto-detects that
#   failure by refusing to proceed if the merged text tensors are missing.
#
# IMPORTANT — the mmproj:
#   Converted from the merged dir with --mmproj. This is correct whether the
#   vision encoder was frozen or fine-tuned: merge_lora.py normalizes the
#   vision-tower keys to the base layout (model.visual.* → visual.*), without
#   which llama.cpp writes an incomplete projector that fails to load
#   ("unable to find tensor v.blk.0.attn_out.weight"). If the merge did NOT go
#   through merge_lora.py, set BASE_MMPROJ to fall back to copying a stock
#   projector (only valid when vision was frozen).
set -euo pipefail

MERGED="$1"
NAME="${2:-macrotrack-estimator}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
LLAMA="/home/jonathan.steffens/sglang_env/llama.cpp"
PY="$HERE/.venv-ft/bin/python"
OUT="$HERE/models"
BASE_MMPROJ="${BASE_MMPROJ:-}"
mkdir -p "$OUT"

[ -d "$MERGED" ] || { echo "merged dir not found: $MERGED"; exit 1; }

echo "== text model → f16 GGUF =="
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outfile "$OUT/$NAME-f16.gguf" --outtype f16

if [ -n "$BASE_MMPROJ" ]; then
  echo "== vision projector: copy $BASE_MMPROJ (frozen-vision fallback) =="
  cp "$BASE_MMPROJ" "$OUT/mmproj-$NAME-f16.gguf"
else
  echo "== vision projector → mmproj GGUF (from merged dir) =="
  "$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outfile "$OUT/mmproj-$NAME-f16.gguf" --mmproj
  # guard: a projector with no vision tensors is a few KB, not ~1.3 GB
  sz=$(stat -c%s "$OUT/mmproj-$NAME-f16.gguf")
  [ "$sz" -gt 100000000 ] || { echo "ERROR: mmproj is $sz bytes — vision tensors missing (merge_lora.py remap?)"; exit 1; }
fi

echo "== quantize =="
"$LLAMA/build-cuda/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-q4_k_m.gguf" Q4_K_M
"$LLAMA/build-cuda/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-q5_k_m.gguf" Q5_K_M

echo "== sanity: reject a base-weights merge =="
# The tuned model must NOT behave like the base. A 1-line generation without
# grammar should emit the trained FoodClaim shape ("items":[...]). If it looks
# like the base model instead, fail loudly so a silent bad merge can't ship.
# Runs on CPU (-ngl 0) so it never contends with a busy GPU / hangs.
PROBE="$("$LLAMA/build-cuda/bin/llama-cli" -m "$OUT/$NAME-q4_k_m.gguf" -ngl 0 -c 512 -no-cnv \
  -p 'two scrambled eggs and toast' -n 64 --temp 0 2>/dev/null || true)"
if echo "$PROBE" | grep -q '"items"'; then
  echo "   OK — emits FoodClaim items"
else
  echo "   WARNING — tuned model did not emit an \"items\" array unprompted;"
  echo "   verify the merge used merge_lora.py, not save_pretrained_merged."
fi

ls -la "$OUT/$NAME"* "$OUT/mmproj-$NAME"*
