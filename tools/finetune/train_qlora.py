#!/usr/bin/env python3
"""QLoRA fine-tune of Qwen2.5-VL-3B-Instruct for the MacroTrack estimator.

Trains the FULL task: (system prompt + user text/photo) -> FoodClaim JSON,
exactly the contract in mobile/src/lib/ai/{prompt,schema}.ts. Data comes from
generate-synthetic.mjs (text) and convert-nutrition5k.mjs (images); labels are
DB-/measurement-derived, never model-guessed.

  .venv-ft/bin/python tools/finetune/train_qlora.py --config runs/<name>/config.json

The config JSON holds every knob (seeds pinned); the run directory gets
config, logs, JSON-validity probes, and checkpoints. Commit configs, not
checkpoints.
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

DEFAULTS = {
    "base_model": "unsloth/Qwen2.5-VL-3B-Instruct",
    "seed": 1,
    "lora_r": 16,
    "lora_alpha": 16,
    "lora_dropout": 0.0,
    "finetune_vision_layers": False,  # vision encoder frozen first (plan step 3)
    "finetune_language_layers": True,
    "finetune_attention_modules": True,
    "finetune_mlp_modules": True,
    "load_in_4bit": True,
    "lr": 1e-4,
    "lr_scheduler": "cosine",
    "epochs": 1,
    "batch_size": 4,
    "grad_accum": 4,
    "warmup_ratio": 0.03,
    "weight_decay": 0.01,
    "max_seq_len": 4096,
    "text_sft": "data/sft/sft-text.jsonl",
    "text_take": None,          # cap text samples (None = all)
    "image_sft": "data/nutrition5k/n5k-train.jsonl",
    "image_repeat": 4,          # oversample the small image set
    "extra_sft": [],            # e.g. corrections/teacher files, each {path, repeat}
    "holdout_frac": 0.01,       # held-out slice for the JSON-validity probe
    "probe_every_steps": 300,
    "probe_n": 24,
    "out_dir": None,            # required: runs/<name>
}


def load_config():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    cfg_path = Path(ap.parse_args().config)
    cfg = {**DEFAULTS, **json.loads(cfg_path.read_text())}
    if not cfg["out_dir"]:
        cfg["out_dir"] = str(cfg_path.parent)
    return cfg


def to_conversation(sample, root):
    """JSONL row -> Unsloth vision chat format (content as typed part lists)."""
    from PIL import Image

    msgs = []
    image = sample.get("image")
    for m in sample["messages"]:
        if m["role"] == "user":
            parts = []
            if image is not None:
                parts.append({"type": "image", "image": Image.open(root / image).convert("RGB")})
                image = None  # only the first user turn carries the photo
            parts.append({"type": "text", "text": m["content"]})
            msgs.append({"role": "user", "content": parts})
        else:
            msgs.append({"role": m["role"], "content": [{"type": "text", "text": m["content"]}]})
    return {"messages": msgs}


def main():
    cfg = load_config()
    out_dir = Path(cfg["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "config.resolved.json").write_text(json.dumps(cfg, indent=2))

    random.seed(cfg["seed"])

    from unsloth import FastVisionModel  # noqa: E402  (must import before transformers)
    import torch
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer
    from unsloth.trainer import UnslothVisionDataCollator

    model, processor = FastVisionModel.from_pretrained(
        cfg["base_model"],
        load_in_4bit=cfg["load_in_4bit"],
        use_gradient_checkpointing="unsloth",
    )
    model = FastVisionModel.get_peft_model(
        model,
        finetune_vision_layers=cfg["finetune_vision_layers"],
        finetune_language_layers=cfg["finetune_language_layers"],
        finetune_attention_modules=cfg["finetune_attention_modules"],
        finetune_mlp_modules=cfg["finetune_mlp_modules"],
        r=cfg["lora_r"],
        lora_alpha=cfg["lora_alpha"],
        lora_dropout=cfg["lora_dropout"],
        bias="none",
        random_state=cfg["seed"],
    )

    # ---- Data ----
    def read_jsonl(path):
        with open(ROOT / path) as f:
            return [json.loads(l) for l in f if l.strip()]

    text_rows = read_jsonl(cfg["text_sft"])
    random.shuffle(text_rows)
    if cfg["text_take"]:
        text_rows = text_rows[: cfg["text_take"]]
    image_rows = read_jsonl(cfg["image_sft"]) * cfg["image_repeat"] if cfg["image_sft"] else []
    extra_rows = []
    for extra in cfg["extra_sft"]:
        extra_rows += read_jsonl(extra["path"]) * extra.get("repeat", 1)

    rows = text_rows + image_rows + extra_rows
    random.shuffle(rows)
    n_hold = max(8, int(len(rows) * cfg["holdout_frac"]))
    holdout, rows = rows[:n_hold], rows[n_hold:]
    print(f"train={len(rows)} (text={len(text_rows)}, image={len(image_rows)}, extra={len(extra_rows)}) holdout={n_hold}")

    convert = lambda r: to_conversation(r, ROOT)

    class ConvDataset(torch.utils.data.Dataset):
        def __init__(self, rows):
            self.rows = rows
        def __len__(self):
            return len(self.rows)
        def __getitem__(self, i):
            return convert(self.rows[i])

    # ---- JSON-validity probe on held-out prompts (text-only for speed) ----
    text_holdout = [r for r in holdout if "image" not in r or r.get("image") is None][: cfg["probe_n"]]
    probe_log = open(out_dir / "probe.log", "a")

    def probe(step):
        FastVisionModel.for_inference(model)
        ok = 0
        for r in text_holdout:
            msgs = [
                {"role": "system", "content": [{"type": "text", "text": r["messages"][0]["content"]}]},
                {"role": "user", "content": [{"type": "text", "text": r["messages"][1]["content"]}]},
            ]
            inputs = processor.apply_chat_template(
                msgs, add_generation_prompt=True, tokenize=True,
                return_dict=True, return_tensors="pt",
            ).to(model.device)
            out = model.generate(**inputs, max_new_tokens=768, do_sample=False,
                                 pad_token_id=processor.tokenizer.eos_token_id)
            text = processor.tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
            try:
                claim = json.loads(text)
                if isinstance(claim.get("items"), list) and "meal_guess" in claim:
                    ok += 1
            except (json.JSONDecodeError, AttributeError):
                pass
        msg = f"step {step}: JSON-valid {ok}/{len(text_holdout)}"
        print(msg)
        probe_log.write(msg + "\n")
        probe_log.flush()
        FastVisionModel.for_training(model)

    class ProbeCallback(TrainerCallback):
        def on_step_end(self, args, state, control, **kw):
            if state.global_step > 0 and state.global_step % cfg["probe_every_steps"] == 0:
                probe(state.global_step)

    # ---- Train ----
    trainer = SFTTrainer(
        model=model,
        processing_class=processor.tokenizer,
        data_collator=UnslothVisionDataCollator(model, processor, resize="max"),
        train_dataset=ConvDataset(rows),
        callbacks=[ProbeCallback()],
        args=SFTConfig(
            per_device_train_batch_size=cfg["batch_size"],
            gradient_accumulation_steps=cfg["grad_accum"],
            num_train_epochs=cfg["epochs"],
            learning_rate=cfg["lr"],
            lr_scheduler_type=cfg["lr_scheduler"],
            warmup_ratio=cfg["warmup_ratio"],
            weight_decay=cfg["weight_decay"],
            logging_steps=20,
            save_strategy="epoch",
            output_dir=str(out_dir / "checkpoints"),
            seed=cfg["seed"],
            optim="adamw_8bit",
            bf16=True,
            report_to="none",
            remove_unused_columns=False,
            dataset_text_field="",
            dataset_kwargs={"skip_prepare_dataset": True},
            max_length=cfg["max_seq_len"],
        ),
    )

    probe(0)
    stats = trainer.train()
    (out_dir / "train_stats.json").write_text(json.dumps(stats.metrics, indent=2))
    probe(-1)  # final

    # ---- Save the LoRA adapter ----
    # NOTE: we deliberately do NOT call save_pretrained_merged here. For
    # Qwen2.5-VL it was observed to silently write BASE weights (the exported
    # GGUF then behaved exactly like the untuned model). Merge as a separate,
    # verifiable step against the fp16 base:
    #   .venv-ft/bin/python tools/finetune/merge_lora.py \
    #       --adapter {out}/checkpoints/final-lora --out {out}/merged
    model.save_pretrained(str(out_dir / "checkpoints" / "final-lora"))
    processor.save_pretrained(str(out_dir / "checkpoints" / "final-lora"))
    print(f"done: LoRA adapter saved to {out_dir}/checkpoints/final-lora")
    print("next: merge_lora.py → export-gguf.sh (see script headers)")


if __name__ == "__main__":
    sys.exit(main())
