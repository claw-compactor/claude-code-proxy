#!/usr/bin/env python3
"""Claude batch labeling pipeline for token-level keep/drop labels.

Sends batches of tokenised prompts to the Claude API and collects
per-token keep (1) / drop (0) labels used to train the compactor model.

Key design decisions
--------------------
* **Model**: claude-opus-4-6 (highest reasoning quality for gold labels).
* **Concurrency**: 2 parallel requests (avoids 503 Queue-full errors that
  occurred at concurrency=5 on the Anthropic API).
* **Batch size**: 20 samples per API call (stays well within context window).
* **Retries**: exponential backoff with jitter for transient errors.

Usage::

    python claude_labeler.py \\
        --input data/unlabelled_samples.jsonl \\
        --output data/gold_labels.jsonl \\
        --model claude-opus-4-6 \\
        --concurrency 2 \\
        --batch-size 20 \\
        --num-samples 15000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import anthropic
except ImportError:
    print(
        "Error: anthropic SDK not installed. Run: pip install anthropic",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-opus-4-6"
DEFAULT_CONCURRENCY = 2          # low to avoid 503 Queue-full
DEFAULT_BATCH_SIZE = 20          # samples per API call
DEFAULT_NUM_SAMPLES = 15_000
MAX_RETRIES = 5
BASE_RETRY_DELAY_S = 2.0
MAX_RETRY_DELAY_S = 60.0

SYSTEM_PROMPT = """\
You are a token-level compression labeler. Given a JSON array of tokens
that form a prompt, decide for EACH token whether it should be KEPT (1) or
DROPPED (0) to produce a shorter prompt that preserves all essential meaning.

Rules:
1. Keep structural tokens (braces, brackets, colons) that define data shape.
2. Keep the first occurrence of every unique field name.
3. Keep all values that convey unique information.
4. Drop redundant whitespace-only tokens (but keep ONE newline between records).
5. Drop duplicate field names once the schema is established.
6. When in doubt, keep the token.

Respond with ONLY a JSON object:
{
  "labels": [1, 0, 1, ...],
  "keep_rate": <float 0-1>,
  "rationale": "<one-line explanation>"
}
"""

logger = logging.getLogger("claude_labeler")

# ---------------------------------------------------------------------------
# Data structures (immutable)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Sample:
    """A single unlabelled token list."""
    id: str
    tokens: list[str]


@dataclass(frozen=True)
class LabelledSample:
    """A sample with gold labels attached."""
    id: str
    tokens: list[str]
    labels: list[int]
    keep_rate: float
    rationale: str
    model: str
    latency_ms: float


@dataclass(frozen=True)
class BatchResult:
    """Outcome of labelling one batch."""
    labelled: list[LabelledSample]
    errors: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


def load_samples(path: Path, num_samples: int) -> list[Sample]:
    """Load up to *num_samples* from a JSONL file.

    Each line must have ``{"id": ..., "tokens": [...]}``
    """
    samples: list[Sample] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            samples.append(Sample(id=obj["id"], tokens=obj["tokens"]))
            if len(samples) >= num_samples:
                break
    logger.info("Loaded %d samples from %s", len(samples), path)
    return samples


def save_labelled(results: list[LabelledSample], path: Path) -> None:
    """Append labelled samples to a JSONL file (idempotent on re-runs)."""
    with open(path, "a", encoding="utf-8") as fh:
        for r in results:
            row = {
                "id": r.id,
                "tokens": r.tokens,
                "labels": r.labels,
                "keep_rate": r.keep_rate,
                "rationale": r.rationale,
                "model": r.model,
                "latency_ms": r.latency_ms,
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# API interaction
# ---------------------------------------------------------------------------


def _build_user_message(batch: list[Sample]) -> str:
    """Serialise a batch of samples into the user prompt."""
    payload = [{"id": s.id, "tokens": s.tokens} for s in batch]
    return (
        "Label each sample below. Return a JSON array with one object per "
        "sample, each containing: id, labels, keep_rate, rationale.\n\n"
        + json.dumps(payload, ensure_ascii=False)
    )


async def _call_api_with_retry(
    client: anthropic.AsyncAnthropic,
    model: str,
    batch: list[Sample],
    semaphore: asyncio.Semaphore,
) -> BatchResult:
    """Send one batch to Claude with retry + backoff."""
    labelled: list[LabelledSample] = []
    errors: list[dict[str, Any]] = []

    user_msg = _build_user_message(batch)

    for attempt in range(1, MAX_RETRIES + 1):
        async with semaphore:
            t0 = time.monotonic()
            try:
                response = await client.messages.create(
                    model=model,
                    max_tokens=4096,
                    system=SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": user_msg}],
                )
                latency_ms = (time.monotonic() - t0) * 1000

                # Parse the response
                text = response.content[0].text
                parsed = json.loads(text)

                # Handle both single-object and array responses
                items = parsed if isinstance(parsed, list) else [parsed]

                for item in items:
                    sample_id = item.get("id", batch[0].id if len(batch) == 1 else "unknown")
                    matching = [s for s in batch if s.id == sample_id]
                    tokens = matching[0].tokens if matching else []

                    labelled.append(
                        LabelledSample(
                            id=sample_id,
                            tokens=tokens,
                            labels=item["labels"],
                            keep_rate=float(item.get("keep_rate", 0.0)),
                            rationale=item.get("rationale", ""),
                            model=model,
                            latency_ms=round(latency_ms, 1),
                        )
                    )

                return BatchResult(labelled=labelled, errors=errors)

            except anthropic.RateLimitError as exc:
                delay = min(
                    BASE_RETRY_DELAY_S * (2 ** (attempt - 1)) + random.uniform(0, 1),
                    MAX_RETRY_DELAY_S,
                )
                logger.warning(
                    "Rate limited (attempt %d/%d), retrying in %.1fs: %s",
                    attempt, MAX_RETRIES, delay, exc,
                )
                await asyncio.sleep(delay)

            except anthropic.APIStatusError as exc:
                if exc.status_code == 503:
                    delay = min(
                        BASE_RETRY_DELAY_S * (2 ** (attempt - 1)) + random.uniform(0, 1),
                        MAX_RETRY_DELAY_S,
                    )
                    logger.warning(
                        "503 Queue full (attempt %d/%d), retrying in %.1fs",
                        attempt, MAX_RETRIES, delay,
                    )
                    await asyncio.sleep(delay)
                else:
                    errors.append({
                        "batch_ids": [s.id for s in batch],
                        "error": str(exc),
                        "status": exc.status_code,
                    })
                    return BatchResult(labelled=labelled, errors=errors)

            except (json.JSONDecodeError, KeyError, IndexError) as exc:
                errors.append({
                    "batch_ids": [s.id for s in batch],
                    "error": f"Parse error: {exc}",
                })
                return BatchResult(labelled=labelled, errors=errors)

            except Exception as exc:
                errors.append({
                    "batch_ids": [s.id for s in batch],
                    "error": f"Unexpected: {exc}",
                })
                return BatchResult(labelled=labelled, errors=errors)

    # Exhausted retries
    errors.append({
        "batch_ids": [s.id for s in batch],
        "error": f"Exhausted {MAX_RETRIES} retries",
    })
    return BatchResult(labelled=labelled, errors=errors)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def label_samples(
    samples: list[Sample],
    model: str = DEFAULT_MODEL,
    concurrency: int = DEFAULT_CONCURRENCY,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> tuple[list[LabelledSample], list[dict[str, Any]]]:
    """Label all samples with bounded concurrency.

    Returns (labelled_list, error_list).
    """
    client = anthropic.AsyncAnthropic(
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
    )

    semaphore = asyncio.Semaphore(concurrency)

    # Chunk samples into batches
    batches = [
        samples[i : i + batch_size]
        for i in range(0, len(samples), batch_size)
    ]
    logger.info(
        "Labelling %d samples in %d batches (concurrency=%d, batch_size=%d, model=%s)",
        len(samples), len(batches), concurrency, batch_size, model,
    )

    tasks = [
        _call_api_with_retry(client, model, batch, semaphore)
        for batch in batches
    ]

    all_labelled: list[LabelledSample] = []
    all_errors: list[dict[str, Any]] = []

    results = await asyncio.gather(*tasks)
    for batch_result in results:
        all_labelled.extend(batch_result.labelled)
        all_errors.extend(batch_result.errors)

    logger.info(
        "Done: %d labelled, %d errors", len(all_labelled), len(all_errors),
    )
    return all_labelled, all_errors


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Claude batch labeling pipeline for token keep/drop labels",
    )
    parser.add_argument(
        "--input", "-i",
        type=Path,
        required=True,
        help="Path to unlabelled JSONL file",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path("data/gold_labels.jsonl"),
        help="Path to output labelled JSONL file (default: data/gold_labels.jsonl)",
    )
    parser.add_argument(
        "--model", "-m",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Claude model to use (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--concurrency", "-c",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"Max parallel API requests (default: {DEFAULT_CONCURRENCY})",
    )
    parser.add_argument(
        "--batch-size", "-b",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Samples per API call (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--num-samples", "-n",
        type=int,
        default=DEFAULT_NUM_SAMPLES,
        help=f"Number of samples to label (default: {DEFAULT_NUM_SAMPLES})",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    """Entry point."""
    args = parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    if not args.input.exists():
        logger.error("Input file not found: %s", args.input)
        sys.exit(1)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        logger.error("ANTHROPIC_API_KEY environment variable is required")
        sys.exit(1)

    # Validate concurrency (guard against 503 Queue-full)
    if args.concurrency > 3:
        logger.warning(
            "Concurrency %d is high — risk of 503 Queue-full errors. "
            "Recommended: 2-3.",
            args.concurrency,
        )

    samples = load_samples(args.input, args.num_samples)
    if not samples:
        logger.error("No samples loaded from %s", args.input)
        sys.exit(1)

    # Ensure output directory exists
    args.output.parent.mkdir(parents=True, exist_ok=True)

    labelled, errors = asyncio.run(
        label_samples(
            samples,
            model=args.model,
            concurrency=args.concurrency,
            batch_size=args.batch_size,
        )
    )

    save_labelled(labelled, args.output)
    logger.info("Saved %d labelled samples to %s", len(labelled), args.output)

    if errors:
        error_path = args.output.with_suffix(".errors.jsonl")
        with open(error_path, "w", encoding="utf-8") as fh:
            for err in errors:
                fh.write(json.dumps(err, ensure_ascii=False) + "\n")
        logger.warning("Saved %d errors to %s", len(errors), error_path)
        sys.exit(2)


if __name__ == "__main__":
    main()
