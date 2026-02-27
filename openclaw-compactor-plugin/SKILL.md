---
name: openclaw-compactor
description: "Compress LLM prompts and workspace files to reduce token usage and cost. Supports English and Chinese. Auto-triggers on long prompts (PreToolUse) and file changes (PostToolUse). v7.0"
metadata:
  {
    "openclaw":
      {
        "emoji": "C",
        "requires": { "bins": ["python3"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "packages":
                [
                  "llmlingua",
                  "sentence-transformers",
                  "numpy",
                  "pyyaml",
                ],
              "label": "Install compression dependencies (pip)",
            },
          ],
      },
  }
---

# OpenClaw Compactor v7.0

Compress LLM prompts before sending to providers. Auto-compress workspace files after writes/edits. Same quality, fewer tokens, less cost.

## When to use

Use this skill when:

- A prompt is long (>500 tokens) and you want to save on token costs
- User says "compress this prompt", "reduce tokens", "make this shorter"
- User invokes `/compress`
- Auto-trigger: prompts exceeding 500 tokens get compressed automatically via PreToolUse hook
- Auto-trigger: files written/edited by the agent get compressed via PostToolUse hook

## Quick start

```bash
# Compress inline text
python3 compress.py "Your very long prompt text here..." --rate 0.5

# Compress from file
python3 compress.py --file prompt.txt --rate 0.4

# Pipe from stdin
echo "long prompt text" | python3 compress.py --stdin

# JSON output
python3 compress.py --file prompt.txt --json

# Compressed text only (no report)
python3 compress.py --file prompt.txt --compressed-only
```

## Compression rates

- `0.3` — Aggressive (70% token reduction, some quality loss)
- `0.5` — Balanced (50% token reduction, good quality)
- `0.7` — Conservative (30% token reduction, excellent quality)
- `1.0` — No compression (passthrough)

For Chinese text, rates are automatically boosted by 0.15 to preserve character-level meaning.

## Quality control

Enable quality checking to verify compressed text preserves meaning:

```bash
python3 compress.py --file prompt.txt --quality --quality-floor 0.80
```

If similarity falls below the floor (default: 0.70), original text is returned unchanged.

Quality levels:
- `excellent` (>= 0.90) — Semantically equivalent
- `good` (>= 0.80) — Minor differences
- `fair` (>= 0.70) — Acceptable
- `poor` (< 0.70) — Compression rejected, original returned

## Smart features

- **Content density detection** — Lists, tables, code get higher retention automatically
- **Language detection** — Chinese/CJK text uses multilingual models and higher retention
- **Lightweight fallback** — Rule-based compression when LLMLingua-2 is not installed
- **Auto-rate adjustment** — Dense/structured content minimum rate clamped to 0.6

## PreToolUse hook (auto-compress prompts)

Add to OpenClaw settings to auto-compress long prompts:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "python3 /path/to/openclaw-compactor-plugin/hooks/pre_tool_use.py"
      }
    ]
  }
}
```

Configure threshold and intercepted tools in `config.yaml`:

```yaml
hooks:
  auto_compress: true
  trigger_threshold: 500
  intercept_tools: ["Bash", "Read", "WebFetch"]
```

## PostToolUse hook (auto-compress files on change) -- NEW in v7.0

Automatically compress workspace files after Write/Edit tool calls.

### Option A: OpenClaw hook discovery (recommended)

Copy the hook into your managed hooks directory and enable it:

```bash
cp -r /path/to/openclaw-compactor-plugin/hooks/compactor-auto-compress ~/.openclaw/hooks/
openclaw hooks enable compactor-auto-compress
```

### Option B: Legacy handler config

Add to your OpenClaw settings:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "message:sent",
          "module": "./hooks/compactor-auto-compress/handler.ts"
        }
      ]
    }
  }
}
```

### Option C: Standalone Python script

Pipe tool result JSON into the PostToolUse hook:

```bash
echo '{"tool":"Write","args":{"file_path":"/path/to/file.md"}}' | \
  python3 /path/to/openclaw-compactor-plugin/hooks/post_tool_use.py
```

### Option D: CLI auto mode

Compress a single changed file directly:

```bash
python3 compress.py auto --changed-file /path/to/file.md
python3 compress.py auto --changed-file /path/to/file.md --quiet --json
```

### Configuration

Edit `config.yaml`:

```yaml
hooks:
  post_tool_auto_compress: true
  post_tool_trigger_threshold: 200
  post_tool_skip_dirs:
    - ".git"
    - "node_modules"
    - "__pycache__"
    - ".openclaw/sessions"
```

## Configuration

Edit `config.yaml` for all settings:

```yaml
compression:
  default_rate: 0.5       # Target compression ratio
  min_tokens: 100         # Skip short prompts
  device: "mps"           # mps / cuda / cpu
  auto_adjust: true       # Density-based rate adjustment

quality:
  floor: 0.70             # Minimum similarity to accept
  enabled: true           # Run quality check

language:
  cjk_threshold: 0.3      # CJK detection threshold
  cjk_rate_boost: 0.15    # Rate boost for Chinese text
```

## Chinese support

The plugin detects Chinese/CJK content automatically:
- CJK text gets a rate boost (default +0.15) to preserve meaning
- Uses multilingual embedding model for quality scoring
- Preserves Chinese punctuation as force tokens
- Mixed EN/CN text handled with moderate boost

## Python API

```python
from compress import compress_prompt

result = compress_prompt(
    "Your long prompt text...",
    rate=0.5,
    quality_check=True,
    quality_floor=0.80,
)

print(result["compressed_text"])
print(result["compression"]["savings_pct"])
```

## Requirements

- Python 3.10+
- LLMLingua-2: `pip install llmlingua` (optional, falls back to rule-based)
- Quality check: `pip install sentence-transformers numpy`
- Config: `pip install pyyaml` (optional, has built-in defaults)
