#!/usr/bin/env bash
# run_self_distill.sh — Run the Claude gold-label generation pipeline
#
# Prerequisites:
#   - ANTHROPIC_API_KEY must be set in the environment
#   - pip install anthropic
#
# Usage:
#   ./train/run_self_distill.sh                    # use defaults from config
#   ./train/run_self_distill.sh --concurrency 3    # override concurrency
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults (match self_distill_config.yaml) ────────────

MODEL="claude-opus-4-6"
NUM_SAMPLES=15000
BATCH_SIZE=20
CONCURRENCY=2
INPUT_FILE="${PROJECT_ROOT}/data/unlabelled_samples.jsonl"
OUTPUT_FILE="${PROJECT_ROOT}/data/gold_labels.jsonl"

# ── Parse overrides ──────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)        MODEL="$2";        shift 2 ;;
        --num-samples)  NUM_SAMPLES="$2";  shift 2 ;;
        --batch-size)   BATCH_SIZE="$2";   shift 2 ;;
        --concurrency)  CONCURRENCY="$2";  shift 2 ;;
        --input)        INPUT_FILE="$2";   shift 2 ;;
        --output)       OUTPUT_FILE="$2";  shift 2 ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Usage: $0 [--model M] [--num-samples N] [--batch-size B] [--concurrency C] [--input FILE] [--output FILE]" >&2
            exit 1
            ;;
    esac
done

# ── Preflight checks ────────────────────────────────────

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "Error: ANTHROPIC_API_KEY is not set." >&2
    exit 1
fi

if [[ ! -f "$INPUT_FILE" ]]; then
    echo "Error: Input file not found: $INPUT_FILE" >&2
    echo "Generate unlabelled samples first, then re-run." >&2
    exit 1
fi

# ── Run ──────────────────────────────────────────────────

echo "=== Self-Distillation: Gold-Label Generation ==="
echo "  Model:       $MODEL"
echo "  Samples:     $NUM_SAMPLES"
echo "  Batch size:  $BATCH_SIZE"
echo "  Concurrency: $CONCURRENCY"
echo "  Input:       $INPUT_FILE"
echo "  Output:      $OUTPUT_FILE"
echo ""

python3 "${SCRIPT_DIR}/claude_labeler.py" \
    --input  "$INPUT_FILE" \
    --output "$OUTPUT_FILE" \
    --model  "$MODEL" \
    --concurrency "$CONCURRENCY" \
    --batch-size  "$BATCH_SIZE" \
    --num-samples "$NUM_SAMPLES" \
    --verbose

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
    echo ""
    echo "Gold-label generation complete."
    LINES=$(wc -l < "$OUTPUT_FILE" | tr -d ' ')
    echo "  Labelled samples: $LINES"
elif [[ $EXIT_CODE -eq 2 ]]; then
    echo ""
    echo "Gold-label generation finished with some errors."
    echo "  Check: ${OUTPUT_FILE%.jsonl}.errors.jsonl"
else
    echo ""
    echo "Gold-label generation failed (exit code $EXIT_CODE)."
fi

exit $EXIT_CODE
