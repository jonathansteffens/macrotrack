#!/usr/bin/env python3
"""Merge a text LoRA adapter into the fp16 base for GGUF export.

Text-only sibling of merge_lora.py (which handled Qwen2.5-VL + vision-key
remap). Loads the FULL-PRECISION base as a causal LM, applies the adapter with
peft, merge_and_unload, saves fp16. Never uses save_pretrained_merged (which was
observed to silently emit base weights — see docs/finetune-report.md).

  .venv-ft/bin/python tools/finetune/merge_lora_text.py \
      --adapter runs/text-0.8b/checkpoints/final-lora \
      --base Qwen/Qwen3.5-0.8B \
      --out runs/text-0.8b/merged
"""
import argparse
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("--adapter", required=True)
ap.add_argument("--base", required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args()

print(f"loading fp16 base {args.base} …")
base = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.float16, device_map="cpu")
print(f"applying adapter {args.adapter} …")
model = PeftModel.from_pretrained(base, args.adapter)
model = model.merge_and_unload()

print(f"saving merged fp16 → {args.out}")
model.save_pretrained(args.out, safe_serialization=True)
AutoTokenizer.from_pretrained(args.base).save_pretrained(args.out)
print("done")
