#!/usr/bin/env python3
"""Merge a trained LoRA adapter into the fp16 base and save for GGUF export.

Robust alternative to Unsloth's save_pretrained_merged, which was observed to
silently emit base weights for Qwen2.5-VL. Loads the FULL-PRECISION base (not
4-bit), applies the adapter with peft, merge_and_unload, saves fp16.

  .venv-ft/bin/python tools/finetune/merge_lora.py \
      --adapter runs/exp1/checkpoints/final-lora \
      --base unsloth/Qwen2.5-VL-3B-Instruct \
      --out runs/exp1/merged
"""
import argparse
import glob
import json
import os
import torch
from safetensors import safe_open
from safetensors.torch import save_file
from transformers import AutoModelForImageTextToText, AutoProcessor
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("--adapter", required=True)
ap.add_argument("--base", default="unsloth/Qwen2.5-VL-3B-Instruct")
ap.add_argument("--out", required=True)
args = ap.parse_args()

print(f"loading fp16 base {args.base} …")
base = AutoModelForImageTextToText.from_pretrained(
    args.base, torch_dtype=torch.float16, device_map="cpu"
)
print(f"applying adapter {args.adapter} …")
model = PeftModel.from_pretrained(base, args.adapter)
model = model.merge_and_unload()

print(f"saving merged fp16 → {args.out}")
model.save_pretrained(args.out, safe_serialization=True)
AutoProcessor.from_pretrained(args.base).save_pretrained(args.out)


def remap_key(k):
    # transformers >=5 saves the VL vision tower as `model.visual.*`, but
    # llama.cpp's convert_hf_to_gguf.py --mmproj (and the base HF repo) expect
    # `visual.*`. Without this, mmproj conversion silently drops the vision
    # tensors and the projector fails to load ("unable to find tensor
    # v.blk.0.attn_out.weight"). Language keys already match the base layout.
    return k[len("model.") :] if k.startswith("model.visual.") else k


print("remapping vision keys (model.visual.* → visual.*) for GGUF/mmproj export …")
index_path = os.path.join(args.out, "model.safetensors.index.json")
if os.path.exists(index_path):
    with open(index_path) as f:
        index = json.load(f)
    index["weight_map"] = {remap_key(k): v for k, v in index["weight_map"].items()}
    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)
n = 0
for shard in glob.glob(os.path.join(args.out, "*.safetensors")):
    with safe_open(shard, framework="pt") as sf:
        meta = sf.metadata() or {}
        tensors = {remap_key(k): sf.get_tensor(k) for k in sf.keys()}
    save_file(tensors, shard, metadata=meta)
    n += len(tensors)
print(f"done: {n} tensors, vision keys normalized to base layout")
