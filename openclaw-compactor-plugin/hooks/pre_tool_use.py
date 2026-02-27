#!/usr/bin/env python3
"""PreToolUse hook for automatic prompt compression.

This hook intercepts tool calls before execution and compresses
prompt arguments that exceed the configured token threshold.

Integration with OpenClaw:
  The hook reads tool call parameters, identifies text-heavy arguments,
  and compresses them transparently before the tool executes.

Usage in OpenClaw settings:
  Add to ~/.openclaw/settings.json or project .openclaw/settings.json:

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

The hook reads a JSON object from stdin with the tool call details,
compresses applicable text fields, and writes the modified JSON to stdout.
"""

import json
import sys
import time
from pathlib import Path

# Add parent to path for lib imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.language import detect_language, estimate_tokens
from lib.density import detect_content_density


def load_hook_config() -> dict:
    """Load hook configuration from config.yaml."""
    config_path = Path(__file__).parent.parent / "config.yaml"
    if config_path.exists():
        try:
            import yaml
            with open(config_path) as f:
                config = yaml.safe_load(f)
                return config.get("hooks", {})
        except ImportError:
            pass
    return {
        "auto_compress": True,
        "trigger_threshold": 500,
        "intercept_tools": ["Bash", "Read", "WebFetch"],
        "log_file": "compression_log.jsonl",
    }


def should_compress(tool_name: str, text: str, config: dict) -> bool:
    """Determine if this tool call's text should be compressed.

    Args:
        tool_name: Name of the tool being called.
        text: The text content to potentially compress.
        config: Hook configuration.

    Returns:
        True if the text should be compressed.
    """
    if not config.get("auto_compress", True):
        return False

    # Check if this tool is in the intercept list
    intercept = config.get("intercept_tools", [])
    if intercept and tool_name not in intercept:
        return False

    # Check token threshold
    threshold = config.get("trigger_threshold", 500)
    lang_profile = detect_language(text)
    token_count = estimate_tokens(text, lang_profile)

    return token_count >= threshold


def compress_tool_args(tool_call: dict, config: dict) -> dict:
    """Compress text-heavy arguments in a tool call.

    Examines tool call parameters and compresses string values
    that exceed the token threshold.

    Args:
        tool_call: The tool call dict with 'tool', 'args' keys.
        config: Hook configuration.

    Returns:
        Modified tool call dict with compressed arguments.
    """
    tool_name = tool_call.get("tool", "")
    args = tool_call.get("args", {})

    if not isinstance(args, dict):
        return tool_call

    # Text-heavy parameter names to check for compression
    text_params = [
        "command", "content", "prompt", "text", "message",
        "query", "description", "body", "input",
    ]

    modified = False
    new_args = dict(args)  # Shallow copy — immutable pattern
    compression_log = []

    for param_name in text_params:
        if param_name not in args:
            continue

        value = args[param_name]
        if not isinstance(value, str):
            continue

        if not should_compress(tool_name, value, config):
            continue

        # Compress this parameter
        try:
            from compress import compress_prompt
            result = compress_prompt(
                value,
                quality_check=False,  # Skip quality for speed in hooks
            )

            comp = result.get("compression", {})
            if not comp.get("skipped", True):
                new_args[param_name] = result["compressed_text"]
                modified = True
                compression_log.append({
                    "param": param_name,
                    "original_tokens": comp.get("original_tokens", 0),
                    "compressed_tokens": comp.get("compressed_tokens", 0),
                    "savings_pct": comp.get("savings_pct", 0),
                    "engine": comp.get("engine", "unknown"),
                })

        except Exception as e:
            # On any error, leave the argument unchanged
            compression_log.append({
                "param": param_name,
                "error": str(e),
            })

    if modified:
        result_call = dict(tool_call)
        result_call["args"] = new_args
        result_call["_compactor_applied"] = True
        result_call["_compactor_log"] = compression_log
        return result_call

    return tool_call


def log_compression(tool_call: dict, config: dict) -> None:
    """Log compression results to JSONL file."""
    log_file = config.get("log_file")
    if not log_file:
        return

    log_path = Path(__file__).parent.parent / log_file
    log_entries = tool_call.get("_compactor_log", [])
    if not log_entries:
        return

    try:
        with open(log_path, "a") as f:
            entry = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "tool": tool_call.get("tool", ""),
                "compressions": log_entries,
            }
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # Logging failure should never break the hook


def main():
    """Hook entry point: read JSON from stdin, compress, write to stdout."""
    config = load_hook_config()

    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception) as e:
        # If we can't parse input, pass through unchanged
        print(json.dumps({"error": f"Failed to parse input: {e}"}))
        sys.exit(0)

    # Process the tool call
    result = compress_tool_args(input_data, config)

    # Log if compression happened
    if result.get("_compactor_applied"):
        log_compression(result, config)
        # Remove internal metadata before passing to OpenClaw
        clean_result = {k: v for k, v in result.items() if not k.startswith("_compactor")}
        print(json.dumps(clean_result, ensure_ascii=False))
    else:
        print(json.dumps(input_data, ensure_ascii=False))


if __name__ == "__main__":
    main()
