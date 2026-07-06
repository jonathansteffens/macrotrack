#!/usr/bin/env bash
# Downloads the slice of Nutrition5k (CC BY 4.0) needed for the Phase 3
# fine-tune: dish metadata, official train/test splits, and the overhead
# RGB frame per dish (~2 GB total). Depth maps, side-angle video, and raw
# sensor data are skipped.
#
#   bash tools/finetune/fetch-nutrition5k.sh [target_dir]   # default data/nutrition5k
#
# Idempotent: already-downloaded files are skipped, so it can be re-run to
# fill gaps after network hiccups.
set -uo pipefail

BASE="https://storage.googleapis.com/nutrition5k_dataset/nutrition5k_dataset"
DIR="${1:-$(dirname "$0")/../../data/nutrition5k}"
mkdir -p "$DIR/metadata" "$DIR/splits" "$DIR/overhead"

echo "== metadata + splits =="
for f in metadata/dish_metadata_cafe1.csv metadata/dish_metadata_cafe2.csv metadata/ingredients_metadata.csv; do
  [ -s "$DIR/$f" ] || curl -sfL -o "$DIR/$f" "$BASE/$f" || echo "FAILED: $f"
done
for f in rgb_train_ids.txt rgb_test_ids.txt; do
  [ -s "$DIR/splits/$f" ] || curl -sfL -o "$DIR/splits/$f" "$BASE/dish_ids/splits/$f" || echo "FAILED: $f"
done

echo "== overhead RGB frames =="
cat "$DIR/splits/rgb_train_ids.txt" "$DIR/splits/rgb_test_ids.txt" | tr -d '\r' | sort -u | \
  while read -r id; do
    [ -n "$id" ] || continue
    [ -s "$DIR/overhead/$id.png" ] || echo "$id"
  done | \
  xargs -P 16 -I{} sh -c \
    'curl -sfL -o "'"$DIR"'/overhead/{}.png" "'"$BASE"'/imagery/realsense_overhead/{}/rgb.png" || rm -f "'"$DIR"'/overhead/{}.png"'

total=$(cat "$DIR/splits/rgb_train_ids.txt" "$DIR/splits/rgb_test_ids.txt" | sort -u | wc -l)
have=$(ls "$DIR/overhead" | wc -l)
echo "overhead frames: $have / $total dish ids (missing ids have no overhead imagery upstream)"
