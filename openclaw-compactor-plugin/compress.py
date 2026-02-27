#!/usr/bin/env python3
"""OpenClaw Compactor Plugin v7.0 — Main entry point.

Provides CLI interface and programmatic API for prompt compression.
Can be invoked via `/compress` command or imported as a module.
Supports automatic compression via PostToolUse hooks.

Usage:
    # CLI
    python compress.py <text-or-file> [--rate 0.5] [--quality] [--json]
    python compress.py --file prompt.txt --rate 0.4

    # Auto-compress a single changed file (for PostToolUse hooks)
    python compress.py auto --changed-file /path/to/file.md

    # As module
    from compress import compress_prompt
    result = compress_prompt("long prompt text here", rate=0.5)
"""

__version__ = "7.0.0"

import argparse
import json
import sys
import time
from pathlib import Path

# Ensure lib is on path
sys.path.insert(0, str(Path(__file__).parent))

from lib.language import detect_language, estimate_tokens
from lib.density import detect_content_density
from lib.quality import compute_similarity, select_model_for_language, QualityLevel


def load_config() -> dict:
    """Load configuration from config.yaml."""
    config_path = Path(__file__).parent / "config.yaml"
    if config_path.exists():
        try:
            import yaml
            with open(config_path) as f:
                return yaml.safe_load(f)
        except ImportError:
            pass
    # Return defaults if yaml not available or file missing
    return {
        "compression": {
            "default_rate": 0.5,
            "min_tokens": 100,
            "auto_trigger_threshold": 500,
            "device": "mps",
            "auto_adjust": True,
            "fallback_to_lightweight": True,
        },
        "quality": {
            "floor": 0.70,
            "enabled": True,
            "en_model": "all-MiniLM-L6-v2",
            "multilingual_model": "paraphrase-multilingual-MiniLM-L12-v2",
        },
    }


def compress_prompt(
    text: str,
    rate: float | None = None,
    quality_check: bool | None = None,
    quality_floor: float | None = None,
    config: dict | None = None,
) -> dict:
    """Compress a prompt and return results.

    This is the primary API for the plugin. It handles:
    1. Language detection (EN/CN/mixed)
    2. Content density analysis
    3. Smart rate adjustment
    4. Compression (LLMLingua-2 or lightweight fallback)
    5. Optional quality verification

    Args:
        text: The prompt text to compress.
        rate: Compression rate (0.0-1.0). None uses config default.
        quality_check: Whether to verify quality. None uses config.
        quality_floor: Minimum similarity score. None uses config.
        config: Override configuration dict.

    Returns:
        Dict with compressed_text, metadata, and quality scores.
    """
    if config is None:
        config = load_config()

    comp_config = config.get("compression", {})
    qual_config = config.get("quality", {})

    if rate is None:
        rate = comp_config.get("default_rate", 0.5)
    if quality_check is None:
        quality_check = qual_config.get("enabled", True)
    if quality_floor is None:
        quality_floor = qual_config.get("floor", 0.70)

    min_tokens = comp_config.get("min_tokens", 100)
    device = comp_config.get("device", "mps")
    auto_adjust = comp_config.get("auto_adjust", True)
    fallback = comp_config.get("fallback_to_lightweight", True)

    # Step 1: Language detection
    lang_profile = detect_language(text)
    token_count = estimate_tokens(text, lang_profile)

    # Step 2: Check minimum length
    if token_count < min_tokens:
        return _build_result(
            original=text,
            compressed=text,
            lang_profile=lang_profile,
            original_tokens=token_count,
            compressed_tokens=token_count,
            rate_requested=rate,
            rate_applied=1.0,
            rate_adjusted=False,
            compression_ms=0.0,
            skipped=True,
            skip_reason=f"Below minimum ({token_count} < {min_tokens} tokens)",
            savings_pct=0.0,
        )

    # Step 3: Try LLMLingua-2 compression
    try:
        from lib.compressor import compress as llm_compress
        result = llm_compress(
            text,
            rate=rate,
            auto_adjust=auto_adjust,
            device=device,
            min_tokens_to_compress=min_tokens,
            quality_floor=quality_floor,
        )

        compressed_text = result.compressed_text
        compression_result = {
            "original_tokens": result.original_tokens,
            "compressed_tokens": result.compressed_tokens,
            "rate_requested": result.rate_requested,
            "rate_applied": result.rate_applied,
            "rate_adjusted": result.rate_adjusted,
            "compression_ms": result.compression_ms,
            "savings_pct": result.savings_pct,
            "skipped": result.skipped,
            "skip_reason": result.skip_reason,
            "engine": "llmlingua2",
        }

    except ImportError:
        if fallback:
            from lib.compressor import compress_lightweight
            result = compress_lightweight(text, rate=rate, min_tokens=min_tokens)

            compressed_text = result.compressed_text
            compression_result = {
                "original_tokens": result.original_tokens,
                "compressed_tokens": result.compressed_tokens,
                "rate_requested": result.rate_requested,
                "rate_applied": result.rate_applied,
                "rate_adjusted": result.rate_adjusted,
                "compression_ms": result.compression_ms,
                "savings_pct": result.savings_pct,
                "skipped": result.skipped,
                "skip_reason": result.skip_reason,
                "engine": "lightweight",
            }
        else:
            return _build_result(
                original=text,
                compressed=text,
                lang_profile=lang_profile,
                original_tokens=token_count,
                compressed_tokens=token_count,
                rate_requested=rate,
                rate_applied=1.0,
                rate_adjusted=False,
                compression_ms=0.0,
                skipped=True,
                skip_reason="LLMLingua-2 not installed and fallback disabled",
                savings_pct=0.0,
            )

    # Step 4: Quality check
    quality_result = None
    if quality_check and not compression_result.get("skipped", False):
        embedding_model = select_model_for_language(lang_profile.cjk_ratio)
        try:
            quality_score = compute_similarity(
                text, compressed_text, model_name=embedding_model,
            )
            quality_result = {
                "similarity": quality_score.similarity,
                "level": quality_score.level.value,
                "model": quality_score.model_used,
                "passes_threshold": quality_score.passes_threshold,
            }

            # If quality is below floor, return original
            if quality_score.similarity < quality_floor:
                return _build_result(
                    original=text,
                    compressed=text,
                    lang_profile=lang_profile,
                    original_tokens=token_count,
                    compressed_tokens=token_count,
                    rate_requested=rate,
                    rate_applied=1.0,
                    rate_adjusted=False,
                    compression_ms=compression_result["compression_ms"],
                    skipped=True,
                    skip_reason=(
                        f"Quality below floor: {quality_score.similarity:.2f} < "
                        f"{quality_floor:.2f} ({quality_score.level.value})"
                    ),
                    savings_pct=0.0,
                    quality=quality_result,
                )

        except Exception as e:
            quality_result = {"error": str(e)}

    # Step 5: Build result
    return {
        "compressed_text": compressed_text,
        "original_text_length": len(text),
        "compressed_text_length": len(compressed_text),
        "language": {
            "detected": lang_profile.language.value,
            "cjk_ratio": lang_profile.cjk_ratio,
            "is_cjk_dominant": lang_profile.is_cjk_dominant,
        },
        "compression": compression_result,
        "quality": quality_result,
        "density": {
            "is_dense": detect_content_density(text).is_dense,
            "reason": detect_content_density(text).reason,
        },
    }


def _build_result(
    original: str,
    compressed: str,
    lang_profile,
    original_tokens: int,
    compressed_tokens: int,
    rate_requested: float,
    rate_applied: float,
    rate_adjusted: bool,
    compression_ms: float,
    skipped: bool,
    skip_reason: str,
    savings_pct: float,
    quality: dict | None = None,
) -> dict:
    """Build a standardized result dict."""
    return {
        "compressed_text": compressed,
        "original_text_length": len(original),
        "compressed_text_length": len(compressed),
        "language": {
            "detected": lang_profile.language.value,
            "cjk_ratio": lang_profile.cjk_ratio,
            "is_cjk_dominant": lang_profile.is_cjk_dominant,
        },
        "compression": {
            "original_tokens": original_tokens,
            "compressed_tokens": compressed_tokens,
            "rate_requested": rate_requested,
            "rate_applied": rate_applied,
            "rate_adjusted": rate_adjusted,
            "compression_ms": compression_ms,
            "savings_pct": savings_pct,
            "skipped": skipped,
            "skip_reason": skip_reason,
            "engine": "none",
        },
        "quality": quality,
    }


def format_report(result: dict) -> str:
    """Format compression result as a human-readable report."""
    comp = result["compression"]
    lang = result["language"]

    lines = []
    lines.append("--- OpenClaw Compactor Report ---")
    lines.append("")

    if comp.get("skipped"):
        lines.append(f"  Skipped: {comp['skip_reason']}")
        lines.append(f"  Language: {lang['detected']} (CJK: {lang['cjk_ratio']:.0%})")
        lines.append(f"  Tokens: {comp['original_tokens']}")
        return "\n".join(lines)

    lines.append(f"  Engine: {comp.get('engine', 'unknown')}")
    lines.append(f"  Language: {lang['detected']} (CJK: {lang['cjk_ratio']:.0%})")
    lines.append(f"  Tokens: {comp['original_tokens']} -> {comp['compressed_tokens']}")
    lines.append(f"  Savings: {comp['savings_pct']:.1f}%")
    lines.append(f"  Rate: requested={comp['rate_requested']}, applied={comp['rate_applied']}")
    if comp.get("rate_adjusted"):
        lines.append(f"  Rate auto-adjusted (dense content detected)")
    lines.append(f"  Time: {comp['compression_ms']:.0f}ms")

    if result.get("quality"):
        q = result["quality"]
        if "error" not in q:
            lines.append(f"  Quality: {q['similarity']:.2f} ({q['level']})")
        else:
            lines.append(f"  Quality: error ({q['error']})")

    density = result.get("density", {})
    if density.get("is_dense"):
        lines.append(f"  Density: dense — {density.get('reason', '')}")

    lines.append("")
    lines.append("--- End Report ---")
    return "\n".join(lines)


# Single-component directories to skip during auto-compression
SKIP_DIRS = frozenset({
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "dist",
    "build",
    ".eggs",
})

# Multi-component path patterns to skip (matched against the full path string)
SKIP_PATH_PATTERNS = (
    ".openclaw/sessions",
)

# File extensions eligible for compression
COMPRESSIBLE_EXTENSIONS = frozenset({
    ".md", ".txt", ".rst", ".log", ".json", ".yaml", ".yml",
    ".toml", ".cfg", ".ini", ".csv", ".tsv",
    ".py", ".js", ".ts", ".mjs", ".jsx", ".tsx",
    ".sh", ".bash", ".zsh",
    ".html", ".css", ".xml",
    ".sql", ".r", ".R",
})


def should_skip_path(file_path: Path) -> tuple[bool, str]:
    """Check if a file path should be skipped for auto-compression.

    Returns (should_skip, reason) tuple.
    """
    parts = file_path.parts
    path_str = str(file_path)

    # Check single-component directory names
    for skip_dir in SKIP_DIRS:
        if skip_dir in parts:
            return True, f"in excluded directory: {skip_dir}"

    # Check multi-component path patterns
    for pattern in SKIP_PATH_PATTERNS:
        if pattern in path_str:
            return True, f"in excluded path: {pattern}"

    if not file_path.suffix:
        return True, "no file extension"

    if file_path.suffix not in COMPRESSIBLE_EXTENSIONS:
        return True, f"extension {file_path.suffix} not compressible"

    if not file_path.exists():
        return True, "file does not exist"

    if file_path.stat().st_size == 0:
        return True, "file is empty"

    # Skip very large files (> 1MB) for hook speed
    if file_path.stat().st_size > 1_048_576:
        return True, "file too large (> 1MB)"

    return False, ""


def auto_compress_file(
    file_path: str,
    config: dict | None = None,
    quiet: bool = False,
) -> dict:
    """Auto-compress a single file. Designed for PostToolUse hook usage.

    This is the fast path for hook-triggered compression. It:
    1. Validates the file path (skips excluded dirs, binary files, etc.)
    2. Reads the file content
    3. Compresses using lightweight mode (no quality check for speed)
    4. Writes compressed content back to the file
    5. Returns a brief summary

    Args:
        file_path: Absolute path to the changed file.
        config: Override configuration dict.
        quiet: If True, suppress all output.

    Returns:
        Dict with compression summary and metadata.
    """
    if config is None:
        config = load_config()

    path = Path(file_path).resolve()

    # Check if we should skip this file
    skip, reason = should_skip_path(path)
    if skip:
        result = {
            "file": str(path),
            "action": "skipped",
            "reason": reason,
            "tokens_saved": 0,
        }
        if not quiet:
            print(f"[compactor] skip {path.name}: {reason}")
        return result

    # Read file content
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        result = {
            "file": str(path),
            "action": "error",
            "reason": f"read error: {e}",
            "tokens_saved": 0,
        }
        if not quiet:
            print(f"[compactor] error {path.name}: {e}")
        return result

    if not text.strip():
        result = {
            "file": str(path),
            "action": "skipped",
            "reason": "file is empty or whitespace-only",
            "tokens_saved": 0,
        }
        if not quiet:
            print(f"[compactor] skip {path.name}: empty")
        return result

    # Check token count against threshold
    hook_config = config.get("hooks", {})
    threshold = hook_config.get("post_tool_trigger_threshold", 200)

    lang_profile = detect_language(text)
    token_count = estimate_tokens(text, lang_profile)

    if token_count < threshold:
        result = {
            "file": str(path),
            "action": "skipped",
            "reason": f"below threshold ({token_count} < {threshold} tokens)",
            "tokens_saved": 0,
        }
        if not quiet:
            print(f"[compactor] skip {path.name}: {token_count} tokens < {threshold} threshold")
        return result

    # Compress (lightweight mode for speed, no quality check)
    t0 = time.time()
    compress_result = compress_prompt(
        text,
        quality_check=False,
        config=config,
    )
    elapsed_ms = (time.time() - t0) * 1000

    comp = compress_result.get("compression", {})

    if comp.get("skipped", True):
        result = {
            "file": str(path),
            "action": "skipped",
            "reason": comp.get("skip_reason", "compression skipped"),
            "tokens_saved": 0,
            "elapsed_ms": round(elapsed_ms, 1),
        }
        if not quiet:
            print(f"[compactor] skip {path.name}: {comp.get('skip_reason', 'no savings')}")
        return result

    original_tokens = comp.get("original_tokens", 0)
    compressed_tokens = comp.get("compressed_tokens", 0)
    tokens_saved = original_tokens - compressed_tokens
    savings_pct = comp.get("savings_pct", 0)

    # Write compressed content back
    compressed_text = compress_result["compressed_text"]
    try:
        path.write_text(compressed_text, encoding="utf-8")
    except OSError as e:
        result = {
            "file": str(path),
            "action": "error",
            "reason": f"write error: {e}",
            "tokens_saved": 0,
        }
        if not quiet:
            print(f"[compactor] error writing {path.name}: {e}")
        return result

    result = {
        "file": str(path),
        "action": "compressed",
        "original_tokens": original_tokens,
        "compressed_tokens": compressed_tokens,
        "tokens_saved": tokens_saved,
        "savings_pct": round(savings_pct, 1),
        "elapsed_ms": round(elapsed_ms, 1),
        "engine": comp.get("engine", "unknown"),
    }

    if not quiet:
        print(
            f"[compactor] {path.name}: {original_tokens} -> {compressed_tokens} tokens "
            f"(-{savings_pct:.0f}%, {elapsed_ms:.0f}ms)"
        )

    return result


def _run_auto_command(args) -> None:
    """Handle the 'auto' subcommand for PostToolUse hook integration."""
    if not args.changed_file:
        print("Error: --changed-file is required for 'auto' command", file=sys.stderr)
        sys.exit(1)

    result = auto_compress_file(
        args.changed_file,
        quiet=args.quiet if hasattr(args, "quiet") else False,
    )

    if args.json if hasattr(args, "json") else False:
        print(json.dumps(result, ensure_ascii=False))


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="OpenClaw Compactor v7.0 — Compress LLM prompts to save tokens",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python compress.py "Your long prompt text here"
  python compress.py --file prompt.txt --rate 0.4
  python compress.py --file prompt.txt --rate 0.5 --quality --json
  echo "long prompt" | python compress.py --stdin

  # Auto-compress a single file (PostToolUse hook mode)
  python compress.py auto --changed-file /path/to/file.md
  python compress.py auto --changed-file /path/to/file.md --quiet --json
        """,
    )

    subparsers = parser.add_subparsers(dest="command")

    # 'auto' subcommand for PostToolUse hook
    auto_parser = subparsers.add_parser(
        "auto",
        help="Auto-compress a changed file (PostToolUse hook mode)",
    )
    auto_parser.add_argument(
        "--changed-file",
        required=True,
        help="Path to the file that was changed",
    )
    auto_parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress output (for background hook use)",
    )
    auto_parser.add_argument(
        "--json",
        action="store_true",
        help="Output result as JSON",
    )

    # Default compress mode (original behavior)
    input_group = parser.add_mutually_exclusive_group(required=False)
    input_group.add_argument("text", nargs="?", help="Text to compress (inline)")
    input_group.add_argument("--file", "-f", help="Read text from file")
    input_group.add_argument("--stdin", action="store_true", help="Read from stdin")

    parser.add_argument("--rate", "-r", type=float, default=None,
                        help="Compression rate (0.0-1.0, default: config)")
    parser.add_argument("--quality", "-q", action="store_true", default=None,
                        help="Enable quality check")
    parser.add_argument("--no-quality", action="store_true",
                        help="Disable quality check")
    parser.add_argument("--quality-floor", type=float, default=None,
                        help="Minimum similarity score (0.0-1.0)")
    parser.add_argument("--json", "-j", action="store_true",
                        help="Output as JSON")
    parser.add_argument("--compressed-only", "-c", action="store_true",
                        help="Output only compressed text (no report)")
    parser.add_argument("--version", "-V", action="version",
                        version=f"%(prog)s {__version__}")

    args = parser.parse_args()

    # Handle 'auto' subcommand
    if args.command == "auto":
        _run_auto_command(args)
        return

    # Original compress behavior — require at least one input
    if not args.file and not args.stdin and not args.text:
        parser.print_help()
        sys.exit(1)

    # Read input
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    elif args.stdin:
        text = sys.stdin.read()
    else:
        text = args.text

    if not text or not text.strip():
        print("Error: No input text provided", file=sys.stderr)
        sys.exit(1)

    # Resolve quality flag
    quality_check = None
    if args.quality:
        quality_check = True
    elif args.no_quality:
        quality_check = False

    # Compress
    result = compress_prompt(
        text,
        rate=args.rate,
        quality_check=quality_check,
        quality_floor=args.quality_floor,
    )

    # Output
    if args.compressed_only:
        print(result["compressed_text"])
    elif args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(format_report(result))
        print()
        print("Compressed text:")
        print("-" * 60)
        print(result["compressed_text"])


if __name__ == "__main__":
    main()
