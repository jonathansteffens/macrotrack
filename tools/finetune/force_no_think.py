#!/usr/bin/env python3
"""Force a Qwen3.5 merged model's chat template to NON-thinking.

The small Qwen3.5 models are hybrid-reasoning: the chat template's generation
prompt branches on `enable_thinking` — true opens `<think>\n` (model reasons),
else emits a CLOSED empty block `<think>\n\n</think>\n\n` (model answers
directly). Our estimator is trained non-thinking (loss only on the JSON claim
after the closed block) and decodes under a JSON grammar, so thinking must be
OFF. If a runtime (llama-server/llama.rn) leaves reasoning on "auto", it opens a
think block, the model reasons freely (grammar is gated until after </think>),
and `content` comes back empty.

Rather than require every runtime to pass reasoning=off, we bake it into the
GGUF: rewrite the generation-prompt conditional so it ALWAYS emits the closed
empty block. Then any runtime using the embedded template gets non-thinking
prompts and the model emits pure JSON — no app-side thinking config needed.

  .venv-ft/bin/python tools/finetune/force_no_think.py <merged_dir>
"""
import json
import re
import sys
from pathlib import Path

d = Path(sys.argv[1])
# transformers 5.x saves the template to a standalone chat_template.jinja;
# older layouts embed it in tokenizer_config.json under "chat_template".
jinja_path = d / "chat_template.jinja"
tc_path = d / "tokenizer_config.json"
if jinja_path.exists():
    mode, ct = "jinja", jinja_path.read_text()
else:
    mode = "embedded"
    tc = json.loads(tc_path.read_text())
    ct = tc["chat_template"]
MARKER = "enable_thinking is defined and enable_thinking is true"
if MARKER not in ct:
    print(f"chat template already non-thinking ({d}) — nothing to do")
    sys.exit(0)

# Replace `{% if enable_thinking...true %}<A>{% else %}<B>{% endif %}` with `<B>`
# (the closed-empty-block branch). Keeps the else-body verbatim, so we don't have
# to hardcode the exact whitespace/escaping of the think string.
new_ct, n = re.subn(
    r"\{%-?\s*if enable_thinking is defined and enable_thinking is true\s*%\}"
    r".*?\{%-?\s*else\s*%\}(.*?)\{%-?\s*endif\s*%\}",
    r"\1",
    ct,
    flags=re.DOTALL,
)
assert n == 1, f"expected exactly 1 enable_thinking conditional, replaced {n}"
assert "enable_thinking is defined and enable_thinking is true" not in new_ct
assert "<think>" in new_ct  # closed empty block still present
if mode == "jinja":
    jinja_path.write_text(new_ct)
    print(f"forced non-thinking chat template in {jinja_path} (replaced {n} conditional)")
else:
    tc["chat_template"] = new_ct
    tc_path.write_text(json.dumps(tc, indent=2, ensure_ascii=False))
    print(f"forced non-thinking chat template in {tc_path} (replaced {n} conditional)")
