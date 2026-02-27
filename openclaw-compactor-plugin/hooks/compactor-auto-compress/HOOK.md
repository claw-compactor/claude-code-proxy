---
name: compactor-auto-compress
description: "Auto-compress files after Write/Edit tool calls to reduce token usage. Triggers on message:sent events and compresses recently-changed workspace files."
homepage: https://github.com/claw-compactor/openclaw-compactor-plugin
metadata:
  {
    "openclaw":
      {
        "emoji": "C",
        "events": ["message:sent"],
        "requires": { "bins": ["python3"] },
      },
  }
---

# Compactor Auto-Compress Hook

Automatically compresses workspace files after Write/Edit tool calls to reduce token usage on subsequent reads.

## What It Does

1. Listens for `message:sent` events (which fire after tool calls complete)
2. Detects if the last tool action was a file Write or Edit
3. Runs lightweight compression on the changed file
4. Logs compression results to `compression_log.jsonl`

## How It Works

The hook calls the OpenClaw Compactor Plugin's `auto --changed-file` mode, which:

- Validates the file path (skips `.git/`, `node_modules/`, `__pycache__/`, etc.)
- Reads the file content and estimates token count
- Skips files below the configured threshold (default: 200 tokens)
- Compresses using the lightweight engine (fast, no ML models needed)
- Writes the compressed content back to the file
- Reports tokens saved in a single-line summary

## Requirements

- Python 3.10+
- The `openclaw-compactor-plugin` directory must be accessible

## Configuration

Edit `config.yaml` in the plugin directory:

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

## Install

### Automatic (recommended)

```bash
cd openclaw-compactor-plugin
python3 compress.py install
```

### Manual

Copy this directory to `~/.openclaw/hooks/compactor-auto-compress/` and enable:

```bash
cp -r hooks/compactor-auto-compress ~/.openclaw/hooks/
openclaw hooks enable compactor-auto-compress
```
