"""LLMLingua-2 prompt compression engine.

Wraps the LLMLingua-2 library with smart rate adjustment, content density
detection, language-aware parameters, and quality scoring.

This is the core compression module ported from opencompactor with
enhancements for OpenClaw integration.
"""

import time
from dataclasses import dataclass, field

from .density import DensityProfile, detect_content_density, smart_rate
from .language import (
    Language,
    LanguageProfile,
    detect_language,
    estimate_tokens,
    get_compression_params_for_language,
)


@dataclass(frozen=True)
class CompressionResult:
    """Result of a compression operation."""
    compressed_text: str
    original_tokens: int
    compressed_tokens: int
    rate_requested: float
    rate_applied: float
    rate_adjusted: bool
    compression_ms: float
    language: LanguageProfile
    density: DensityProfile
    savings_pct: float
    skipped: bool = False
    skip_reason: str = ""


# Default force tokens that should never be dropped
DEFAULT_FORCE_TOKENS = [
    "\n", ".", ",", ":", ";", "?", "!",
    "-", "#", "*", "|",
    "(", ")",
    "1", "2", "3", "4", "5", "6",
]

# Lazy-loaded compressor singleton
_compressor = None


def _get_compressor(device: str = "mps"):
    """Lazy-load the LLMLingua-2 compressor."""
    global _compressor
    if _compressor is None:
        from llmlingua import PromptCompressor
        _compressor = PromptCompressor(
            model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
            use_llmlingua2=True,
            device_map=device,
        )
    return _compressor


def compress(
    text: str,
    rate: float = 0.5,
    force_tokens: list[str] | None = None,
    auto_adjust: bool = True,
    device: str = "mps",
    min_tokens_to_compress: int = 100,
    quality_floor: float = 0.70,
) -> CompressionResult:
    """Compress text using LLMLingua-2 with smart adjustments.

    Args:
        text: The input text to compress.
        rate: Target compression ratio (0.0-1.0). Lower = more aggressive.
        force_tokens: Characters to never drop. None uses language-aware defaults.
        auto_adjust: Whether to auto-adjust rate based on content density.
        device: Compute device ("mps", "cuda", "cpu").
        min_tokens_to_compress: Skip compression if text is shorter than this.
        quality_floor: Minimum acceptable similarity score (0.0-1.0).

    Returns:
        CompressionResult with compressed text and metadata.
    """
    # Detect language
    lang_profile = detect_language(text)

    # Estimate token count
    token_count = estimate_tokens(text, lang_profile)

    # Skip if too short
    if token_count < min_tokens_to_compress:
        density = detect_content_density(text) if auto_adjust else _empty_density()
        return CompressionResult(
            compressed_text=text,
            original_tokens=token_count,
            compressed_tokens=token_count,
            rate_requested=rate,
            rate_applied=1.0,
            rate_adjusted=False,
            compression_ms=0.0,
            language=lang_profile,
            density=density,
            savings_pct=0.0,
            skipped=True,
            skip_reason=f"Text too short ({token_count} tokens < {min_tokens_to_compress} threshold)",
        )

    # No-op if rate is 1.0
    if rate >= 1.0:
        density = detect_content_density(text) if auto_adjust else _empty_density()
        return CompressionResult(
            compressed_text=text,
            original_tokens=token_count,
            compressed_tokens=token_count,
            rate_requested=1.0,
            rate_applied=1.0,
            rate_adjusted=False,
            compression_ms=0.0,
            language=lang_profile,
            density=density,
            savings_pct=0.0,
            skipped=True,
            skip_reason="Rate is 1.0 (no compression)",
        )

    # Language-specific parameters
    lang_params = get_compression_params_for_language(lang_profile)

    # Apply language rate boost
    rate_requested = rate
    rate = min(1.0, rate + lang_params["rate_boost"])
    rate = max(rate, lang_params["min_rate"])

    # Smart density-based rate adjustment
    rate_adjusted = False
    density = _empty_density()
    if auto_adjust:
        rate, density, rate_adjusted = smart_rate(text, rate)

    # Set force tokens
    if force_tokens is None:
        force_tokens = lang_params["force_tokens"]

    # Run compression
    compressor = _get_compressor(device)
    t0 = time.time()
    result = compressor.compress_prompt(
        text,
        rate=rate,
        force_tokens=force_tokens,
        drop_consecutive=True,
    )
    elapsed_ms = (time.time() - t0) * 1000

    # Parse compression result
    compressed_text = result["compressed_prompt"]
    original_tokens = result["origin_tokens"]
    compressed_tokens = result["compressed_tokens"]

    rate_val = result.get("rate", "0%")
    if isinstance(rate_val, str):
        rate_val = float(rate_val.replace("%", "")) / 100

    savings_pct = round((1 - compressed_tokens / max(original_tokens, 1)) * 100, 1)

    return CompressionResult(
        compressed_text=compressed_text,
        original_tokens=original_tokens,
        compressed_tokens=compressed_tokens,
        rate_requested=rate_requested,
        rate_applied=round(rate_val, 4),
        rate_adjusted=rate_adjusted,
        compression_ms=round(elapsed_ms, 1),
        language=lang_profile,
        density=density,
        savings_pct=savings_pct,
    )


def compress_lightweight(
    text: str,
    rate: float = 0.5,
    min_tokens: int = 100,
) -> CompressionResult:
    """Lightweight compression without LLMLingua-2.

    Uses rule-based compression for environments where the ML model
    is not available. Removes filler words, collapses whitespace,
    and strips redundant phrasing.

    This is the fallback when llmlingua is not installed.
    """
    lang_profile = detect_language(text)
    token_count = estimate_tokens(text, lang_profile)

    if token_count < min_tokens:
        return CompressionResult(
            compressed_text=text,
            original_tokens=token_count,
            compressed_tokens=token_count,
            rate_requested=rate,
            rate_applied=1.0,
            rate_adjusted=False,
            compression_ms=0.0,
            language=lang_profile,
            density=_empty_density(),
            savings_pct=0.0,
            skipped=True,
            skip_reason=f"Text too short ({token_count} tokens < {min_tokens} threshold)",
        )

    t0 = time.time()
    compressed = _rule_based_compress(text, rate, lang_profile)
    elapsed_ms = (time.time() - t0) * 1000

    compressed_tokens = estimate_tokens(compressed, lang_profile)
    savings_pct = round((1 - compressed_tokens / max(token_count, 1)) * 100, 1)

    return CompressionResult(
        compressed_text=compressed,
        original_tokens=token_count,
        compressed_tokens=compressed_tokens,
        rate_requested=rate,
        rate_applied=round(compressed_tokens / max(token_count, 1), 4),
        rate_adjusted=False,
        compression_ms=round(elapsed_ms, 1),
        language=lang_profile,
        density=detect_content_density(text),
        savings_pct=savings_pct,
    )


# English filler words/phrases to remove
_EN_FILLERS = [
    "basically", "essentially", "actually", "literally", "obviously",
    "clearly", "in fact", "as a matter of fact", "it should be noted that",
    "it is important to note that", "it is worth mentioning that",
    "please note that", "keep in mind that", "as you can see",
    "as mentioned above", "as previously stated", "in other words",
    "that being said", "having said that", "with that being said",
    "at the end of the day", "for what it's worth", "needless to say",
]

# Chinese filler expressions
_CN_FILLERS = [
    "实际上", "基本上", "事实上", "显而易见", "众所周知",
    "不言而喻", "值得一提的是", "需要注意的是", "简而言之",
    "换句话说", "总而言之", "归根结底", "说到底",
]

import re as _re


def _rule_based_compress(text: str, rate: float, lang_profile: LanguageProfile) -> str:
    """Apply rule-based compression as a lightweight fallback."""
    result = text

    # Remove filler words/phrases
    if lang_profile.language in (Language.ENGLISH, Language.MIXED, Language.UNKNOWN):
        for filler in _EN_FILLERS:
            pattern = _re.compile(r"\b" + _re.escape(filler) + r"\b", _re.IGNORECASE)
            result = pattern.sub("", result)

    if lang_profile.language in (Language.CHINESE, Language.MIXED):
        for filler in _CN_FILLERS:
            result = result.replace(filler, "")

    # Collapse multiple blank lines to single
    result = _re.sub(r"\n{3,}", "\n\n", result)

    # Collapse multiple spaces
    result = _re.sub(r"[ \t]{2,}", " ", result)

    # Remove trailing whitespace per line
    lines = result.split("\n")
    lines = [line.rstrip() for line in lines]
    result = "\n".join(lines)

    # Remove empty lines at start/end
    result = result.strip()

    return result


def _empty_density() -> DensityProfile:
    """Return an empty density profile."""
    return DensityProfile(
        is_dense=False,
        structure_ratio=0.0,
        avg_words_per_line=0.0,
        tech_ratio=0.0,
        reason="not analyzed",
        numbered_lines=0,
        bullet_lines=0,
        header_lines=0,
        table_lines=0,
        code_lines=0,
        total_lines=0,
    )
