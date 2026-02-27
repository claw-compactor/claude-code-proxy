"""Content density detection for smart compression rate adjustment.

Detects whether text is dense/structured (lists, tables, code, markdown)
versus verbose natural language, and adjusts compression rates accordingly
to avoid destroying structured content.

Ported from opencompactor/compressor.py with enhancements for CJK content.
"""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class DensityProfile:
    """Result of content density analysis."""
    is_dense: bool
    structure_ratio: float
    avg_words_per_line: float
    tech_ratio: float
    reason: str
    numbered_lines: int
    bullet_lines: int
    header_lines: int
    table_lines: int
    code_lines: int
    total_lines: int


def detect_content_density(text: str) -> DensityProfile:
    """Analyze text structure to determine content density.

    Dense content (lists, tables, code, markdown headers) should be
    compressed less aggressively to preserve structure.
    """
    lines = [line for line in text.strip().split("\n") if line.strip()]
    if not lines:
        return DensityProfile(
            is_dense=False,
            structure_ratio=0.0,
            avg_words_per_line=0.0,
            tech_ratio=0.0,
            reason="empty",
            numbered_lines=0,
            bullet_lines=0,
            header_lines=0,
            table_lines=0,
            code_lines=0,
            total_lines=0,
        )

    total = len(lines)

    # Detect structural patterns
    numbered = sum(1 for line in lines if re.match(r"^\s*\d+[\.\)]\s", line))
    bullets = sum(1 for line in lines if re.match(r"^\s*[-*\u2022]\s", line))
    headers = sum(1 for line in lines if re.match(r"^#{1,6}\s", line))
    tables = sum(1 for line in lines if "|" in line and line.count("|") >= 2)
    code_fence = sum(1 for line in lines if re.match(r"^\s*```", line))
    # Lines inside code blocks (rough estimate)
    code_lines = _count_code_lines(lines)

    structure_count = numbered + bullets + headers + tables + code_lines
    structure_ratio = structure_count / total

    # Average words per line
    avg_words = sum(len(line.split()) for line in lines) / total

    # Technical term density
    words = text.split()
    tech_ratio = 0.0
    if words:
        technical = sum(1 for w in words if _is_technical_term(w))
        tech_ratio = technical / len(words)

    # Determine density
    reasons = []
    if structure_ratio > 0.15:
        reasons.append(f"structured({structure_ratio:.0%} lines)")
    if avg_words < 12:
        reasons.append(f"short-lines({avg_words:.0f} words/line)")
    if tech_ratio > 0.20:
        reasons.append(f"technical({tech_ratio:.0%} terms)")
    if code_lines > total * 0.1:
        reasons.append(f"code({code_lines} lines)")

    is_dense = bool(reasons)

    return DensityProfile(
        is_dense=is_dense,
        structure_ratio=round(structure_ratio, 3),
        avg_words_per_line=round(avg_words, 1),
        tech_ratio=round(tech_ratio, 3),
        reason=", ".join(reasons) if reasons else "verbose natural language",
        numbered_lines=numbered,
        bullet_lines=bullets,
        header_lines=headers,
        table_lines=tables,
        code_lines=code_lines,
        total_lines=total,
    )


def smart_rate(text: str, requested_rate: float) -> tuple[float, DensityProfile, bool]:
    """Adjust compression rate based on content density.

    Returns (adjusted_rate, density_profile, was_adjusted).
    Dense/structured content gets a higher minimum rate to preserve structure.
    """
    density = detect_content_density(text)

    if density.is_dense and requested_rate < 0.6:
        return 0.6, density, True

    return requested_rate, density, False


def _is_technical_term(word: str) -> bool:
    """Check if a word appears to be a technical term."""
    if len(word) < 2:
        return False
    # camelCase or PascalCase
    if any(c.isupper() for c in word[1:] if c.isalpha()):
        return True
    # Hyphenated compound (e.g., "cross-entropy")
    if "-" in word and len(word) > 3:
        return True
    # Contains digits (e.g., "GPT-4", "v3.2")
    if any(c.isdigit() for c in word):
        return True
    # All-caps acronym (e.g., "LLM", "API")
    if word.isupper() and len(word) > 2:
        return True
    return False


def _count_code_lines(lines: list[str]) -> int:
    """Count lines inside code fence blocks."""
    in_code = False
    count = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            count += 1
        elif in_code:
            count += 1
    return count
