#!/usr/bin/env python3
"""PostToolUse hook for automatic file compression on writes/edits.

This hook intercepts tool results after Write or Edit tool calls and
compresses the changed file if it exceeds the configured token threshold.

Unlike the PreToolUse hook (which compresses prompt arguments), this hook
compresses the actual files that were written or edited, reducing their
token footprint for future reads.

Integration with OpenClaw:
  The hook reads a JSON object from stdin with the tool result details,
  identifies the file that was changed, and runs compression on it.

Usage in OpenClaw settings (legacy format):
  {
    "hooks": {
      "internal": {
        "enabled": true,
        "handlers": [
          {
            "event": "tool_result_persist",
            "module": "./hooks/compactor-auto-compress/handler.ts"
          }
        ]
      }
    }
  }

Or as a standalone script:
  echo '{"tool":"Write","args":{"file_path":"/path/to/file.md"}}' | \
    python3 hooks/post_tool_use.py
"""

import json
import sys
import time
from pathlib import Path

# Add parent to path for lib imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from compress import auto_compress_file, should_skip_path, load_config


def extract_file_path(tool_call: dict) -> str | None:
    """Extract the file path from a Write or Edit tool result.

    Handles different tool argument formats:
    - Write: {"tool": "Write", "args": {"file_path": "/path/to/file"}}
    - Edit: {"tool": "Edit", "args": {"file_path": "/path/to/file"}}
    - NotebookEdit: {"tool": "NotebookEdit", "args": {"notebook_path": "/path"}}

    Returns the file path string, or None if not applicable.
    """
    tool = tool_call.get("tool", "")
    args = tool_call.get("args", {})

    if not isinstance(args, dict):
        return None

    # Match tools that modify files
    if tool in ("Write", "Edit"):
        return args.get("file_path")
    elif tool == "NotebookEdit":
        return args.get("notebook_path")

    return None


def is_write_or_edit_tool(tool_call: dict) -> bool:
    """Check if the tool call is a file-modifying operation."""
    tool = tool_call.get("tool", "")
    return tool in ("Write", "Edit", "NotebookEdit")


def process_post_tool_use(tool_call: dict, config: dict) -> dict:
    """Process a PostToolUse event and compress the changed file if applicable.

    Args:
        tool_call: The tool call dict with 'tool', 'args' keys.
        config: Plugin configuration.

    Returns:
        Dict with compression result summary.
    """
    if not is_write_or_edit_tool(tool_call):
        return {
            "action": "ignored",
            "reason": f"tool '{tool_call.get('tool', '')}' is not a file write/edit",
        }

    file_path = extract_file_path(tool_call)
    if not file_path:
        return {
            "action": "ignored",
            "reason": "no file_path found in tool args",
        }

    # Check hook enable flag
    hook_config = config.get("hooks", {})
    if not hook_config.get("post_tool_auto_compress", True):
        return {
            "action": "disabled",
            "reason": "post_tool_auto_compress is disabled in config",
        }

    # Run auto-compression on the changed file
    result = auto_compress_file(file_path, config=config, quiet=True)
    return result


def log_result(result: dict, config: dict) -> None:
    """Log post-tool compression result to JSONL file."""
    hook_config = config.get("hooks", {})
    log_file = hook_config.get("log_file")
    if not log_file:
        return

    log_path = Path(__file__).parent.parent / log_file
    try:
        with open(log_path, "a") as f:
            entry = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "hook": "post_tool_use",
                "result": result,
            }
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # Logging failure should never block the hook


def main():
    """Hook entry point: read JSON from stdin, compress changed file, report."""
    config = load_config()

    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception) as e:
        # If we can't parse input, pass through silently
        print(json.dumps({"action": "error", "reason": f"parse error: {e}"}))
        sys.exit(0)

    result = process_post_tool_use(input_data, config)

    # Log the result
    log_result(result, config)

    # Output one-line summary to stdout
    action = result.get("action", "unknown")
    if action == "compressed":
        file_name = Path(result.get("file", "")).name
        saved = result.get("tokens_saved", 0)
        pct = result.get("savings_pct", 0)
        print(f"[compactor] {file_name}: -{saved} tokens ({pct:.0f}% saved)")
    elif action == "error":
        print(f"[compactor] error: {result.get('reason', 'unknown')}")
    # For 'skipped', 'ignored', 'disabled' — stay silent in hook mode


if __name__ == "__main__":
    main()
