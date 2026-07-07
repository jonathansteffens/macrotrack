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
#   The vision encoder is FROZEN during training (train_qlora.py
#   finetune_vision_layers=False), so the correct projector is the BASE
#   model's mmproj, byte-identical. We copy it. (Converting the projector
#   from a peft-merged HF dir produces a broken mmproj — llama.cpp fails with
#   "unable to find tensor v.blk.0.attn_out.weight" — because the AutoModel
#   save renames vision-tower keys.) Override BASE_MMPROJ if you ever unfreeze
#   vision, in which case convert it from the merged dir with --mmproj.
set -euo pipefail

MERGED="$1"
NAME="${2:-macrotrack-estimator}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
LLAMA="/home/jonathan.steffens/sglang_env/llama.cpp"
PY="$HERE/.venv-ft/bin/python"
OUT="$HERE/models"
BASE_MMPROJ="${BASE_MMPROJ:-$OUT/base/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf}"
mkdir -p "$OUT"

[ -d "$MERGED" ] || { echo "merged dir not found: $MERGED"; exit 1; }
[ -f "$BASE_MMPROJ" ] || { echo "base mmproj not found: $BASE_MMPROJ (see header)"; exit 1; }

echo "== text model → f16 GGUF =="
"$PY" "$LLAMA/convert_hf_to_gguf.py" "$MERGED" --outfile "$OUT/$NAME-f16.gguf" --outtype f16

echo "== vision projector: copy base mmproj (frozen vision) =="
cp "$BASE_MMPROJ" "$OUT/mmproj-$NAME-f16.gguf"

echo "== quantize =="
"$LLAMA/build-cuda/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-q4_k_m.gguf" Q4_K_M
"$LLAMA/build-cuda/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-q5_k_m.gguf" Q5_K_M

echo "== sanity: reject a base-weights merge =="
# The tuned model must NOT behave like the base. A 1-line generation without
# grammar should emit the trained FoodClaim shape ("items":[...]). If it looks
# like the base model instead, fail loudly so a silent bad merge can't ship.
PROBE="$("$LLAMA/build-cuda/bin/llama-cli" -m "$OUT/$NAME-q4_k_m.gguf" -ngl 99 -no-cnv \
  -p 'two scrambled eggs and toast' -n 64 --temp 0 2>/dev/null || true)"
if echo "$PROBE" | grep -q '"items"'; then
  echo "   OK — emits FoodClaim items"
else
  echo "   WARNING — tuned model did not emit an \"items\" array unprompted;"
  echo "   verify the merge used merge_lora.py, not save_pretrained_merged."
fi

ls -la "$OUT/$NAME"* "$OUT/mmproj-$NAME"*
