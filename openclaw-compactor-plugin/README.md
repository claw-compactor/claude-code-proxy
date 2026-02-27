# OpenClaw Compactor Plugin v7.0

Prompt and file compression plugin for OpenClaw. Reduces LLM token usage by 30-60% while preserving semantic meaning. Auto-compresses workspace files after agent writes/edits. Built on [OpenCompactor](https://github.com/claw-compactor/opencompactor) and LLMLingua-2.

## Architecture

```
openclaw-compactor-plugin/
├── SKILL.md                  # OpenClaw skill definition
├── compress.py               # Main entry point (CLI + API + auto mode)
├── config.yaml               # Configuration with sensible defaults
├── requirements.txt          # Python dependencies
├── lib/
│   ├── __init__.py
│   ├── compressor.py         # LLMLingua-2 wrapper + lightweight fallback
│   ├── density.py            # Content density detection
│   ├── language.py           # Language detection (EN/CN/mixed)
│   └── quality.py            # Semantic similarity scoring
├── hooks/
│   ├── __init__.py
│   ├── pre_tool_use.py       # PreToolUse hook for prompt auto-compression
│   ├── post_tool_use.py      # PostToolUse hook for file auto-compression
│   └── compactor-auto-compress/  # OpenClaw discoverable hook
│       ├── HOOK.md           # Hook metadata + documentation
│       └── handler.ts        # TypeScript handler for OpenClaw gateway
└── tests/
    ├── __init__.py
    ├── test_language.py       # Language detection tests
    ├── test_density.py        # Density detection tests
    ├── test_compress.py       # End-to-end compression tests
    └── test_auto_compress.py  # PostToolUse auto-compression tests
```

## How It Works

### Compression Pipeline

```
Input Prompt
    │
    ├─ Step 1: Language Detection
    │   └─ Classify as EN / CN / mixed
    │   └─ Select language-specific parameters
    │
    ├─ Step 2: Content Density Analysis
    │   └─ Detect structured content (lists, tables, code)
    │   └─ Auto-adjust compression rate for dense content
    │
    ├─ Step 3: Compression
    │   ├─ Primary: LLMLingua-2 (XLM-RoBERTa token pruning)
    │   └─ Fallback: Rule-based filler removal
    │
    ├─ Step 4: Quality Verification (optional)
    │   └─ Cosine similarity via sentence-transformers
    │   └─ Reject if below quality floor
    │
    └─ Output: Compressed prompt + metadata
```

### Language-Aware Compression

Chinese text is information-dense at the character level. Each CJK character carries significantly more meaning than an English letter. The plugin handles this by:

1. **Detecting CJK content** -- Scans Unicode ranges to compute a CJK ratio
2. **Boosting retention** -- Adds +0.15 to the compression rate for CJK-dominant text
3. **Preserving CJK punctuation** -- Adds Chinese punctuation marks to force tokens
4. **Multilingual quality scoring** -- Uses `paraphrase-multilingual-MiniLM-L12-v2` instead of the English-only model

For mixed EN/CN content (common in technical discussions), a moderate +0.10 boost is applied.

### Content Density Detection

Structured content (API docs, markdown tables, numbered lists, code blocks) loses meaning if over-compressed. The density detector scans for:

- Numbered lists (`1.`, `2)`, etc.)
- Bullet points (`-`, `*`)
- Markdown headers (`#`, `##`, etc.)
- Table rows (lines with `|` separators)
- Code fence blocks (lines between triple backticks)
- Technical terms (camelCase, ACRONYMS, version numbers)

When content is detected as dense, the minimum compression rate is clamped to 0.6 regardless of the requested rate.

### Quality Scoring

After compression, an optional quality check computes cosine similarity between the original and compressed text using sentence-transformers:

| Score | Level | Action |
|-------|-------|--------|
| >= 0.90 | Excellent | Accept, semantically equivalent |
| >= 0.80 | Good | Accept, minor differences |
| >= 0.70 | Fair | Accept, at threshold |
| < 0.70 | Poor | Reject, return original text |

The quality floor is configurable (default: 0.70). When the compressed text falls below the floor, the original text is returned unchanged.

## Installation

### Full installation (with LLMLingua-2)

```bash
cd openclaw-compactor-plugin
pip install -r requirements.txt
```

This installs LLMLingua-2, sentence-transformers, and all dependencies (~2GB of models downloaded on first use).

### Lightweight installation (rule-based only)

```bash
pip install pyyaml
```

Without LLMLingua-2, the plugin falls back to rule-based compression (filler word removal, whitespace normalization). Savings are lower (5-15%) but no ML models are needed.

## Usage

### CLI

```bash
# Basic compression
python3 compress.py "Your long prompt..." --rate 0.5

# From file with quality check
python3 compress.py --file prompt.txt --rate 0.4 --quality

# JSON output for programmatic use
python3 compress.py --file prompt.txt --json

# Compressed text only
python3 compress.py --file prompt.txt --compressed-only

# From stdin
cat long_prompt.txt | python3 compress.py --stdin --rate 0.5
```

### Python API

```python
from compress import compress_prompt, format_report

# Compress with defaults
result = compress_prompt("Your long prompt text...")

# Compress with custom settings
result = compress_prompt(
    text="Your long prompt text...",
    rate=0.4,
    quality_check=True,
    quality_floor=0.80,
)

# Access results
print(result["compressed_text"])
print(result["compression"]["savings_pct"])
print(result["compression"]["original_tokens"])
print(result["language"]["detected"])  # "en", "zh", "mixed"

# Human-readable report
print(format_report(result))
```

### OpenClaw Skill Invocation

Via `/compress` command in OpenClaw:

```
/compress rate=0.5 quality=true
<your long prompt here>
```

### Auto-Compress Mode (PostToolUse Hook)

Compress a single file after it was written/edited by the agent:

```bash
# Basic usage — compress a file in-place
python3 compress.py auto --changed-file /path/to/file.md

# Quiet mode for hook usage (one-line summary)
python3 compress.py auto --changed-file /path/to/file.md --quiet

# JSON output for programmatic use
python3 compress.py auto --changed-file /path/to/file.md --json
```

Files in `.git/`, `node_modules/`, `__pycache__/`, etc. are automatically skipped. Files below the token threshold (default: 200) are also skipped for speed.

### PreToolUse Hook (Auto-Compression)

Add to your OpenClaw settings to auto-compress prompts over 500 tokens:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "python3 /absolute/path/to/openclaw-compactor-plugin/hooks/pre_tool_use.py"
      }
    ]
  }
}
```

The hook silently compresses long text arguments in tool calls, logging results to `compression_log.jsonl`.

### PostToolUse Hook (File Auto-Compression) -- NEW in v7.0

Auto-compress workspace files after Write/Edit tool calls. Three setup options:

#### Option A: OpenClaw Hook Discovery (recommended)

```bash
# Copy hook to managed hooks directory
cp -r /path/to/openclaw-compactor-plugin/hooks/compactor-auto-compress ~/.openclaw/hooks/

# Enable it
openclaw hooks enable compactor-auto-compress
```

#### Option B: Legacy Handler Config

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

#### Option C: Python Script (pipe tool results)

```bash
echo '{"tool":"Write","args":{"file_path":"/path/to/file.md"}}' | \
  python3 /path/to/openclaw-compactor-plugin/hooks/post_tool_use.py
```

## Configuration Reference

All settings in `config.yaml`:

| Setting | Default | Description |
|---------|---------|-------------|
| `compression.default_rate` | 0.5 | Target compression ratio |
| `compression.min_tokens` | 100 | Skip prompts shorter than this |
| `compression.auto_trigger_threshold` | 500 | Auto-compress above this |
| `compression.device` | "mps" | Compute device for LLMLingua-2 |
| `compression.auto_adjust` | true | Density-based rate adjustment |
| `compression.fallback_to_lightweight` | true | Use rule-based fallback |
| `quality.floor` | 0.70 | Minimum similarity to accept |
| `quality.enabled` | true | Run quality check |
| `quality.en_model` | "all-MiniLM-L6-v2" | English embedding model |
| `quality.multilingual_model` | "paraphrase-multilingual-MiniLM-L12-v2" | CJK model |
| `language.cjk_threshold` | 0.3 | CJK detection threshold |
| `language.cjk_rate_boost` | 0.15 | Rate boost for CJK text |
| `hooks.auto_compress` | true | Enable PreToolUse auto-compression |
| `hooks.trigger_threshold` | 500 | PreToolUse trigger token count |
| `hooks.intercept_tools` | ["Bash","Read","WebFetch"] | Tools to intercept |
| `hooks.post_tool_auto_compress` | true | Enable PostToolUse file compression |
| `hooks.post_tool_trigger_threshold` | 200 | PostToolUse file token threshold |
| `hooks.post_tool_skip_dirs` | [".git","node_modules",...] | Dirs to skip |

## Relationship to OpenCompactor

This plugin wraps the [OpenCompactor](https://github.com/claw-compactor/opencompactor) compression engine and extends it for OpenClaw integration:

| Feature | OpenCompactor | This Plugin |
|---------|---------------|-------------|
| LLMLingua-2 compression | Yes | Yes (reused) |
| Content density detection | Yes | Yes (reused + enhanced) |
| Quality scoring | Yes | Yes (reused + multilingual) |
| Chinese/CJK support | Partial | Full (language detection + rate boost) |
| OpenClaw skill | No | Yes (SKILL.md) |
| PreToolUse hook | No | Yes (prompt auto-compression) |
| PostToolUse hook | No | Yes (file auto-compression, v7.0) |
| OpenClaw discoverable hook | No | Yes (HOOK.md + handler.ts) |
| Rule-based fallback | No | Yes (lightweight mode) |
| CLI interface | No (web only) | Yes |
| Python API | No (FastAPI only) | Yes |
| Auto single-file mode | No | Yes (`auto --changed-file`) |

## Dependencies

Required:
- Python 3.10+

Optional (for full functionality):
- `llmlingua` -- LLMLingua-2 compression engine
- `sentence-transformers` -- Quality scoring
- `numpy` -- Vector operations
- `pyyaml` -- Configuration loading
- `tiktoken` -- Precise token counting

## License

MIT
