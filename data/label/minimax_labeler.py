#!/usr/bin/env python3
"""MiniMax Token Labeler — Generate keep/drop labels for compactor training.

Sends token lists to the MiniMax-M2.5 228B model (llama.cpp on M3 512)
and collects binary keep/drop labels for each token.

The model runs locally at 172.28.216.81:8080 — no rate limits, so default
concurrency is 8 (was incorrectly set to 1 previously).

Usage:
    # Label a single token_labels.json file
    python minimax_labeler.py --input tokens.json --output labels.json

    # Label with custom endpoint
    python minimax_labeler.py --input tokens.json --endpoint http://host:8080/v1

    # Batch mode (directory of token files)
    python minimax_labeler.py --input-dir ./samples/ --output-dir ./labeled/

    # Adjust concurrency (default: 8 for local model)
    python minimax_labeler.py --input tokens.json --concurrency 4
"""

__version__ = "1.1.0"

import argparse
import asyncio
import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any

try:
    import httpx
except ImportError:
    httpx = None

try:
    import aiohttp
except ImportError:
    aiohttp = None


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_ENDPOINT = "http://172.28.216.81:8080/v1"
DEFAULT_MODEL = "MiniMax-M2.5-Q8_0-00001-of-00006.gguf"
DEFAULT_CONCURRENCY = 8  # Local model, no rate limits — run parallel
DEFAULT_MAX_RETRIES = 3
DEFAULT_TIMEOUT_S = 120
DEFAULT_TEMPERATURE = 0.0  # Deterministic for labeling

LOG = logging.getLogger("minimax_labeler")


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a JSON-only labeling API. You NEVER output explanations, commentary, \
markdown, or any text outside of the JSON array. You respond with raw JSON only.

Rules:
- Output ONLY a JSON array of 0s and 1s.
- 1 = keep the token, 0 = drop the token.
- The array length MUST equal the number of tokens provided.
- Do NOT wrap the array in an object, markdown code fence, or any other text.
- Do NOT include any explanation before or after the JSON array.
- Your entire response must be parseable by JSON.parse() with no preprocessing.\
"""

USER_PROMPT_TEMPLATE = """\
Label each token: 1=keep, 0=drop. Respond ONLY with a JSON array, no other text.

Tokens ({token_count} total):
{tokens_json}

Respond with ONLY a JSON array of exactly {token_count} integers (0 or 1). \
Example for 5 tokens: [1,0,1,1,0]
No markdown. No explanation. No code fences. Just the JSON array.\
"""

# Simpler retry prompt — even more restrictive for models that were verbose
RETRY_PROMPT_TEMPLATE = """\
Return ONLY a JSON array of {token_count} integers (0 or 1). Nothing else.

Tokens:
{tokens_json}

Output:["""


# ---------------------------------------------------------------------------
# JSON extraction — aggressive regex for verbose model responses
# ---------------------------------------------------------------------------

# Pattern 1: Standard JSON array at any position in the response
_RE_JSON_ARRAY = re.compile(
    r'\[[\s]*(?:[01][\s]*,[\s]*)*[01][\s]*\]',
    re.DOTALL,
)

# Pattern 2: Array possibly wrapped in markdown code fences
_RE_FENCED_JSON = re.compile(
    r'```(?:json)?\s*(\[[\s\S]*?\])\s*```',
    re.DOTALL,
)

# Pattern 3: Comma-separated 0/1 values (no brackets), e.g. "1,0,1,0,1"
_RE_BARE_VALUES = re.compile(
    r'(?:^|[\n:])[\s]*((?:[01][\s]*,[\s]*){2,}[01])[\s]*(?:$|[\n])',
    re.DOTALL,
)

# Pattern 4: Space-separated 0/1 values, e.g. "1 0 1 0 1"
_RE_SPACE_VALUES = re.compile(
    r'(?:^|[\n:])[\s]*((?:[01]\s+){2,}[01])[\s]*(?:$|[\n])',
    re.DOTALL,
)


def extract_json_labels(raw_response: str, expected_count: int) -> list[int] | None:
    """Extract a JSON array of 0/1 labels from a potentially verbose response.

    Tries multiple strategies in order of reliability:
    1. Direct JSON parse of the full response
    2. Find JSON array via regex
    3. Extract from markdown code fences
    4. Parse bare comma-separated values
    5. Parse space-separated values

    Args:
        raw_response: The raw text from the model.
        expected_count: Expected number of labels (must match token count).

    Returns:
        List of ints (0 or 1) if extraction succeeds, None otherwise.
    """
    if not raw_response or not raw_response.strip():
        return None

    text = raw_response.strip()

    # Strategy 1: Direct JSON parse
    labels = _try_parse_json_array(text, expected_count)
    if labels is not None:
        return labels

    # Strategy 2: If response starts with '[' after the model continued our "Output:["
    # the response might be "0,1,1,0,...]" (missing opening bracket)
    if not text.startswith("[") and re.match(r'^[\s]*[01][\s]*,', text):
        patched = "[" + text
        # Truncate at first ']'
        bracket_idx = patched.find("]")
        if bracket_idx > 0:
            patched = patched[:bracket_idx + 1]
        labels = _try_parse_json_array(patched, expected_count)
        if labels is not None:
            return labels

    # Strategy 3: Regex — find JSON array anywhere in text
    for match in _RE_JSON_ARRAY.finditer(text):
        candidate = match.group(0)
        labels = _try_parse_json_array(candidate, expected_count)
        if labels is not None:
            return labels

    # Strategy 4: Markdown code fences
    for match in _RE_FENCED_JSON.finditer(text):
        candidate = match.group(1).strip()
        labels = _try_parse_json_array(candidate, expected_count)
        if labels is not None:
            return labels

    # Strategy 5: Bare comma-separated values
    for match in _RE_BARE_VALUES.finditer(text):
        candidate = match.group(1).strip()
        values = [v.strip() for v in candidate.split(",") if v.strip()]
        labels = _validate_label_list(values, expected_count)
        if labels is not None:
            return labels

    # Strategy 6: Space-separated values
    for match in _RE_SPACE_VALUES.finditer(text):
        candidate = match.group(1).strip()
        values = candidate.split()
        labels = _validate_label_list(values, expected_count)
        if labels is not None:
            return labels

    # Strategy 7: Last resort — find ALL 0/1 digits in the response
    all_bits = re.findall(r'\b([01])\b', text)
    if len(all_bits) == expected_count:
        return [int(b) for b in all_bits]

    return None


def _try_parse_json_array(text: str, expected_count: int) -> list[int] | None:
    """Try to parse text as a JSON array and validate it."""
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None

    if not isinstance(parsed, list):
        # Maybe it's wrapped in an object like {"labels": [...]}
        if isinstance(parsed, dict):
            for key in ("labels", "label", "output", "result", "data"):
                if key in parsed and isinstance(parsed[key], list):
                    parsed = parsed[key]
                    break
            else:
                return None
        else:
            return None

    return _validate_label_list(parsed, expected_count)


def _validate_label_list(
    values: list[Any], expected_count: int
) -> list[int] | None:
    """Validate that a list contains exactly expected_count 0/1 values."""
    if len(values) != expected_count:
        return None

    result = []
    for v in values:
        try:
            iv = int(v)
        except (ValueError, TypeError):
            return None
        if iv not in (0, 1):
            return None
        result.append(iv)

    return result


# ---------------------------------------------------------------------------
# HTTP client — works with httpx (preferred) or aiohttp
# ---------------------------------------------------------------------------

async def _call_minimax(
    endpoint: str,
    model: str,
    messages: list[dict],
    temperature: float,
    timeout_s: int,
) -> str:
    """Call the MiniMax llama.cpp endpoint (OpenAI-compatible chat/completions).

    Returns the raw content string from the first choice.
    Raises on HTTP/network errors.
    """
    url = f"{endpoint.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
        "stream": False,
    }

    if httpx is not None:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
    elif aiohttp is not None:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url, json=payload, timeout=aiohttp.ClientTimeout(total=timeout_s)
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
    else:
        raise ImportError(
            "Either httpx or aiohttp is required. Install one: pip install httpx"
        )

    choices = data.get("choices", [])
    if not choices:
        raise ValueError(f"No choices in response: {json.dumps(data)[:200]}")

    content = choices[0].get("message", {}).get("content", "")
    return content


# ---------------------------------------------------------------------------
# Labeling logic
# ---------------------------------------------------------------------------

async def label_tokens(
    tokens: list[str],
    endpoint: str = DEFAULT_ENDPOINT,
    model: str = DEFAULT_MODEL,
    temperature: float = DEFAULT_TEMPERATURE,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> dict:
    """Label a list of tokens with keep/drop decisions.

    Uses the MiniMax model to generate binary labels. Retries with
    progressively simpler prompts on failure.

    Args:
        tokens: List of token strings to label.
        endpoint: OpenAI-compatible API endpoint.
        model: Model identifier.
        temperature: Sampling temperature (0.0 = deterministic).
        timeout_s: Request timeout in seconds.
        max_retries: Maximum retry attempts.

    Returns:
        Dict with tokens, labels, keep_rate, and metadata.
    """
    token_count = len(tokens)
    tokens_json = json.dumps(tokens, ensure_ascii=False)

    for attempt in range(1, max_retries + 1):
        try:
            # First attempt: full prompt with system message
            if attempt == 1:
                messages = [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": USER_PROMPT_TEMPLATE.format(
                            token_count=token_count,
                            tokens_json=tokens_json,
                        ),
                    },
                ]
            else:
                # Retry: simpler prompt, prefill the response start
                messages = [
                    {"role": "system", "content": "Respond ONLY with a JSON array."},
                    {
                        "role": "user",
                        "content": RETRY_PROMPT_TEMPLATE.format(
                            token_count=token_count,
                            tokens_json=tokens_json,
                        ),
                    },
                ]

            LOG.info(
                "Attempt %d/%d: labeling %d tokens via %s",
                attempt, max_retries, token_count, endpoint,
            )
            t0 = time.monotonic()
            raw_response = await _call_minimax(
                endpoint, model, messages, temperature, timeout_s,
            )
            elapsed = time.monotonic() - t0

            LOG.debug(
                "Raw response (attempt %d, %.1fs): %s",
                attempt, elapsed, raw_response[:300],
            )

            # Extract labels with aggressive parsing
            labels = extract_json_labels(raw_response, token_count)
            if labels is not None:
                keep_count = sum(labels)
                keep_rate = round(keep_count / token_count, 3) if token_count > 0 else 0.0

                LOG.info(
                    "Success on attempt %d: %d/%d kept (%.1f%%) in %.1fs",
                    attempt, keep_count, token_count, keep_rate * 100, elapsed,
                )

                return {
                    "tokens": tokens,
                    "labels": labels,
                    "keep_rate": keep_rate,
                    "token_count": token_count,
                    "keep_count": keep_count,
                    "model": model,
                    "attempt": attempt,
                    "elapsed_s": round(elapsed, 2),
                }

            # Labels extraction failed — log and retry
            LOG.warning(
                "Attempt %d: JSON extraction failed. Response (%d chars): %s",
                attempt, len(raw_response), raw_response[:500],
            )

        except Exception as exc:
            LOG.warning(
                "Attempt %d: request failed: %s", attempt, exc,
            )

    # All retries exhausted
    LOG.error(
        "All %d attempts failed for %d tokens. Returning None labels.",
        max_retries, token_count,
    )
    return {
        "tokens": tokens,
        "labels": None,
        "keep_rate": None,
        "token_count": token_count,
        "keep_count": None,
        "model": model,
        "attempt": max_retries,
        "elapsed_s": None,
        "error": "All retry attempts exhausted — could not extract valid labels",
    }


# ---------------------------------------------------------------------------
# Batch processing with concurrency control
# ---------------------------------------------------------------------------

async def label_batch(
    items: list[dict],
    endpoint: str = DEFAULT_ENDPOINT,
    model: str = DEFAULT_MODEL,
    concurrency: int = DEFAULT_CONCURRENCY,
    temperature: float = DEFAULT_TEMPERATURE,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> list[dict]:
    """Label multiple token lists concurrently.

    Args:
        items: List of dicts, each with a "tokens" key.
        endpoint: OpenAI-compatible API endpoint.
        model: Model identifier.
        concurrency: Max parallel requests (default: 8 for local model).
        temperature: Sampling temperature.
        timeout_s: Per-request timeout.
        max_retries: Max retries per item.

    Returns:
        List of result dicts (same order as input).
    """
    semaphore = asyncio.Semaphore(concurrency)
    results: list[dict | None] = [None] * len(items)

    async def _process(idx: int, item: dict) -> None:
        tokens = item.get("tokens", [])
        if not tokens:
            results[idx] = {
                "tokens": [],
                "labels": [],
                "keep_rate": 0.0,
                "token_count": 0,
                "keep_count": 0,
                "model": model,
                "error": "Empty token list",
            }
            return

        async with semaphore:
            result = await label_tokens(
                tokens=tokens,
                endpoint=endpoint,
                model=model,
                temperature=temperature,
                timeout_s=timeout_s,
                max_retries=max_retries,
            )
            results[idx] = result

    tasks = [_process(i, item) for i, item in enumerate(items)]
    await asyncio.gather(*tasks)

    return results


# ---------------------------------------------------------------------------
# File I/O helpers
# ---------------------------------------------------------------------------

def load_token_file(path: Path) -> dict:
    """Load a token file (JSON with a "tokens" key)."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, list):
        return {"tokens": data}
    if isinstance(data, dict) and "tokens" in data:
        return data

    raise ValueError(f"Invalid token file format: {path} (expected 'tokens' key or array)")


def save_labels_file(path: Path, result: dict) -> None:
    """Save labeled result to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    LOG.info("Saved labels to %s", path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="MiniMax Token Labeler v{} — Generate keep/drop labels for compactor training".format(
            __version__
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--input", "-i",
        help="Path to a single token file (JSON with 'tokens' array)",
    )
    parser.add_argument(
        "--output", "-o",
        help="Path for the output labels file (default: <input>_labeled.json)",
    )
    parser.add_argument(
        "--input-dir",
        help="Directory of token files for batch labeling",
    )
    parser.add_argument(
        "--output-dir",
        help="Directory for batch output (default: <input-dir>/labeled/)",
    )
    parser.add_argument(
        "--endpoint", "-e",
        default=DEFAULT_ENDPOINT,
        help=f"OpenAI-compatible API endpoint (default: {DEFAULT_ENDPOINT})",
    )
    parser.add_argument(
        "--model", "-m",
        default=DEFAULT_MODEL,
        help=f"Model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--concurrency", "-c",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"Max concurrent requests (default: {DEFAULT_CONCURRENCY})",
    )
    parser.add_argument(
        "--temperature", "-t",
        type=float,
        default=DEFAULT_TEMPERATURE,
        help=f"Sampling temperature (default: {DEFAULT_TEMPERATURE})",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_S,
        help=f"Request timeout in seconds (default: {DEFAULT_TIMEOUT_S})",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=DEFAULT_MAX_RETRIES,
        help=f"Max retries per item (default: {DEFAULT_MAX_RETRIES})",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--version", "-V",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    return parser


async def _async_main(args: argparse.Namespace) -> int:
    """Async entry point for CLI."""
    if args.input:
        # Single file mode
        input_path = Path(args.input)
        if not input_path.exists():
            LOG.error("Input file not found: %s", input_path)
            return 1

        data = load_token_file(input_path)
        result = await label_tokens(
            tokens=data["tokens"],
            endpoint=args.endpoint,
            model=args.model,
            temperature=args.temperature,
            timeout_s=args.timeout,
            max_retries=args.max_retries,
        )

        output_path = Path(args.output) if args.output else input_path.with_name(
            input_path.stem + "_labeled.json"
        )
        save_labels_file(output_path, result)

        if result.get("labels") is not None:
            print(
                f"Labeled {result['token_count']} tokens: "
                f"{result['keep_count']} kept ({result['keep_rate']:.1%})"
            )
        else:
            print(f"FAILED: {result.get('error', 'unknown error')}")
            return 1

    elif args.input_dir:
        # Batch mode
        input_dir = Path(args.input_dir)
        if not input_dir.is_dir():
            LOG.error("Input directory not found: %s", input_dir)
            return 1

        output_dir = Path(args.output_dir) if args.output_dir else input_dir / "labeled"

        files = sorted(input_dir.glob("*.json"))
        if not files:
            LOG.error("No JSON files found in %s", input_dir)
            return 1

        items = []
        file_paths = []
        for f in files:
            try:
                data = load_token_file(f)
                items.append(data)
                file_paths.append(f)
            except (json.JSONDecodeError, ValueError) as exc:
                LOG.warning("Skipping %s: %s", f.name, exc)

        if not items:
            LOG.error("No valid token files found")
            return 1

        LOG.info(
            "Batch labeling %d files with concurrency=%d",
            len(items), args.concurrency,
        )

        results = await label_batch(
            items=items,
            endpoint=args.endpoint,
            model=args.model,
            concurrency=args.concurrency,
            temperature=args.temperature,
            timeout_s=args.timeout,
            max_retries=args.max_retries,
        )

        succeeded = 0
        failed = 0
        for file_path, result in zip(file_paths, results):
            out_path = output_dir / (file_path.stem + "_labeled.json")
            save_labels_file(out_path, result)
            if result.get("labels") is not None:
                succeeded += 1
            else:
                failed += 1

        print(f"Batch complete: {succeeded} succeeded, {failed} failed out of {len(items)}")
        return 1 if failed > 0 else 0

    else:
        LOG.error("Provide --input or --input-dir")
        return 1

    return 0


def main() -> int:
    """CLI entry point."""
    parser = _build_parser()
    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    sys.exit(main())
