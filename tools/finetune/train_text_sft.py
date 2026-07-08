#!/usr/bin/env python3
"""Text-only LoRA SFT for the MacroTrack estimator on small Qwen3.5 models.

Trains (system prompt + user text) -> FoodClaim JSON — the exact contract in
mobile/src/lib/ai/{prompt,schema}.ts. Data = generate-synthetic.mjs output
(data/sft/sft-text.jsonl); labels are DB-derived, never model-guessed. This is
the text-only successor to train_qlora.py (which was Qwen2.5-VL + a vision
collator); Qwen3.5-small is a hybrid-SSM *text* model here (loaded as
Qwen3_5ForCausalLM — no vision tower), so plain transformers + peft is enough.

Non-thinking (the small Qwen3.5 default): the chat template emits an empty
`<think>\n\n</think>\n\n` inside the PROMPT (add_generation_prompt=True), so the
model generates pure JSON — matching the grammar-constrained app/eval path. We
therefore mask the loss over the whole prompt (incl. the empty think block) and
train only on `{JSON claim}<|im_end|>`. Train- and inference-time templates are
identical (llama-server is run with --jinja using the same embedded template).

  .venv-ft/bin/python tools/finetune/train_text_sft.py --config runs/<name>/config.json

Saves the LoRA adapter only (never save_pretrained_merged — see the report's
gotcha); merge with merge_lora_text.py, then export-gguf-text.sh.
"""
import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

DEFAULTS = {
    "base_model": "Qwen/Qwen3.5-0.8B",
    "seed": 1,
    "lora_r": 16,
    "lora_alpha": 16,
    "lora_dropout": 0.0,
    "load_in_4bit": False,        # bf16 LoRA: GPU is free, cleaner than 4-bit for tiny models
    "lr": 2e-4,
    "lr_scheduler": "cosine",
    "epochs": 1,
    "batch_size": 16,
    "grad_accum": 2,              # effective batch 32
    "warmup_ratio": 0.03,
    "weight_decay": 0.01,
    "max_seq_len": 2048,
    "text_sft": "data/sft/sft-text.jsonl",
    "text_take": None,            # cap samples (None = all); use for dry runs
    "holdout_frac": 0.01,         # held-out slice for the JSON-validity probe
    "probe_every_steps": 400,
    "probe_n": 24,
    "out_dir": None,              # required: runs/<name>
}


def load_config():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    cfg_path = Path(ap.parse_args().config)
    cfg = {**DEFAULTS, **json.loads(cfg_path.read_text())}
    if not cfg["out_dir"]:
        cfg["out_dir"] = str(cfg_path.parent)
    return cfg


def main():
    cfg = load_config()
    out_dir = Path(cfg["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "config.resolved.json").write_text(json.dumps(cfg, indent=2))

    import torch
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        Trainer,
        TrainerCallback,
        TrainingArguments,
    )
    from peft import LoraConfig, get_peft_model

    random.seed(cfg["seed"])
    torch.manual_seed(cfg["seed"])

    tok = AutoTokenizer.from_pretrained(cfg["base_model"])
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    IM_END = tok.convert_tokens_to_ids("<|im_end|>")
    IGN = -100

    model_kwargs = dict(dtype=torch.bfloat16)
    if cfg["load_in_4bit"]:
        from transformers import BitsAndBytesConfig
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
    model = AutoModelForCausalLM.from_pretrained(cfg["base_model"], device_map={"": 0}, **model_kwargs)
    model.config.use_cache = False

    lora = LoraConfig(
        r=cfg["lora_r"],
        lora_alpha=cfg["lora_alpha"],
        lora_dropout=cfg["lora_dropout"],
        bias="none",
        task_type="CAUSAL_LM",
        target_modules="all-linear",  # SSM in/out proj + attn q/k/v/o + MLP; excludes lm_head
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # ---- Data: build masked examples (loss only on the JSON claim + <|im_end|>) ----
    def read_jsonl(path):
        with open(ROOT / path) as f:
            return [json.loads(l) for l in f if l.strip()]

    rows = read_jsonl(cfg["text_sft"])
    random.shuffle(rows)
    if cfg["text_take"]:
        rows = rows[: cfg["text_take"]]
    n_hold = max(8, int(len(rows) * cfg["holdout_frac"]))
    holdout, train_rows = rows[:n_hold], rows[n_hold:]
    print(f"train={len(train_rows)} holdout={len(holdout)} (base={cfg['base_model']})")

    def encode(row):
        sys_m, usr_m, asst_m = row["messages"]
        prompt_ids = tok.apply_chat_template(
            [sys_m, usr_m], add_generation_prompt=True, tokenize=True, return_dict=True
        )["input_ids"]
        target_ids = tok(asst_m["content"], add_special_tokens=False)["input_ids"] + [IM_END]
        input_ids = prompt_ids + target_ids
        labels = [IGN] * len(prompt_ids) + target_ids
        if len(input_ids) > cfg["max_seq_len"]:
            input_ids = input_ids[: cfg["max_seq_len"]]
            labels = labels[: cfg["max_seq_len"]]
        return {"input_ids": input_ids, "labels": labels}

    class SFTDataset(torch.utils.data.Dataset):
        def __init__(self, rows):
            self.enc = [encode(r) for r in rows]
        def __len__(self):
            return len(self.enc)
        def __getitem__(self, i):
            return self.enc[i]

    train_ds = SFTDataset(train_rows)
    # sanity: how many target tokens on average (should be ~200-400, the JSON)
    tgt_lens = [sum(1 for x in train_ds.enc[i]["labels"] if x != IGN) for i in range(min(200, len(train_ds)))]
    print(f"sample target-token lengths: mean={sum(tgt_lens)/len(tgt_lens):.0f} max={max(tgt_lens)}")

    def collate(batch):
        maxlen = max(len(b["input_ids"]) for b in batch)
        input_ids, labels, attn = [], [], []
        for b in batch:
            pad = maxlen - len(b["input_ids"])
            input_ids.append(b["input_ids"] + [tok.pad_token_id] * pad)
            labels.append(b["labels"] + [IGN] * pad)
            attn.append([1] * len(b["input_ids"]) + [0] * pad)
        return {
            "input_ids": torch.tensor(input_ids),
            "labels": torch.tensor(labels),
            "attention_mask": torch.tensor(attn),
        }

    # ---- JSON-validity probe on held-out prompts (greedy, no grammar) ----
    probe_rows = holdout[: cfg["probe_n"]]
    probe_log = open(out_dir / "probe.log", "a")

    def probe(step):
        was_training = model.training
        model.eval()
        model.config.use_cache = True
        ok = 0
        for r in probe_rows:
            sys_m, usr_m, _ = r["messages"]
            enc = tok.apply_chat_template(
                [sys_m, usr_m], add_generation_prompt=True, tokenize=True,
                return_dict=True, return_tensors="pt",
            ).to(model.device)
            with torch.no_grad():
                gen = model.generate(
                    **enc, max_new_tokens=640, do_sample=False, pad_token_id=tok.pad_token_id
                )
            text = tok.decode(gen[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
            try:
                claim = json.loads(text)
                if isinstance(claim.get("items"), list) and "meal_guess" in claim:
                    ok += 1
            except (json.JSONDecodeError, AttributeError):
                pass
        model.config.use_cache = False
        if was_training:
            model.train()
        msg = f"step {step}: JSON-valid {ok}/{len(probe_rows)}"
        print(msg)
        probe_log.write(msg + "\n")
        probe_log.flush()

    class ProbeCallback(TrainerCallback):
        def on_step_end(self, args, state, control, **kw):
            if state.global_step > 0 and state.global_step % cfg["probe_every_steps"] == 0:
                probe(state.global_step)

    args = TrainingArguments(
        output_dir=str(out_dir / "checkpoints"),
        per_device_train_batch_size=cfg["batch_size"],
        gradient_accumulation_steps=cfg["grad_accum"],
        num_train_epochs=cfg["epochs"],
        learning_rate=cfg["lr"],
        lr_scheduler_type=cfg["lr_scheduler"],
        warmup_ratio=cfg["warmup_ratio"],
        weight_decay=cfg["weight_decay"],
        logging_steps=20,
        save_strategy="no",
        seed=cfg["seed"],
        bf16=True,
        optim="adamw_torch",
        report_to="none",
        remove_unused_columns=False,
        dataloader_num_workers=4,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        data_collator=collate,
        callbacks=[ProbeCallback()],
    )

    probe(0)
    stats = trainer.train()
    (out_dir / "train_stats.json").write_text(json.dumps(stats.metrics, indent=2))
    probe(-1)

    adapter_dir = out_dir / "checkpoints" / "final-lora"
    model.save_pretrained(str(adapter_dir))
    tok.save_pretrained(str(adapter_dir))
    print(f"done: LoRA adapter saved to {adapter_dir}")
    print("next: merge_lora_text.py --adapter {} --base {} --out {}/merged".format(
        adapter_dir, cfg["base_model"], out_dir))


if __name__ == "__main__":
    sys.exit(main())
