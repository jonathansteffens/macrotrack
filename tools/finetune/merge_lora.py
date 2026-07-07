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
import torch
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
print("done")
