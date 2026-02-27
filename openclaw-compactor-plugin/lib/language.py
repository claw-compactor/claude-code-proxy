"""Language detection with Chinese (CJK) support.

Detects whether text is primarily Chinese, English, or mixed,
and selects appropriate compression parameters accordingly.
"""

import re
from dataclasses import dataclass
from enum import Enum


class Language(Enum):
    """Detected primary language of text."""
    ENGLISH = "en"
    CHINESE = "zh"
    MIXED = "mixed"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class LanguageProfile:
    """Result of language detection."""
    language: Language
    cjk_ratio: float
    ascii_ratio: float
    char_count: int
    cjk_count: int

    @property
    def is_cjk_dominant(self) -> bool:
        return self.cjk_ratio > 0.3

    @property
    def is_mixed(self) -> bool:
        return 0.1 < self.cjk_ratio <= 0.3


# CJK Unicode ranges
_CJK_RANGES = [
    (0x4E00, 0x9FFF),    # CJK Unified Ideographs
    (0x3400, 0x4DBF),    # CJK Unified Ideographs Extension A
    (0x20000, 0x2A6DF),  # CJK Unified Ideographs Extension B
    (0xF900, 0xFAFF),    # CJK Compatibility Ideographs
    (0x2F800, 0x2FA1F),  # CJK Compatibility Ideographs Supplement
    (0x3000, 0x303F),    # CJK Symbols and Punctuation
    (0xFF00, 0xFFEF),    # Halfwidth and Fullwidth Forms
]

# Chinese-specific punctuation
_CN_PUNCTUATION = set("，。！？、；：""''（）【】《》「」『』〈〉…—～·")


def _is_cjk(char: str) -> bool:
    """Check if a character is CJK."""
    cp = ord(char)
    return any(start <= cp <= end for start, end in _CJK_RANGES) or char in _CN_PUNCTUATION


def detect_language(text: str) -> LanguageProfile:
    """Detect the primary language of the given text.

    Returns a LanguageProfile with language classification and statistics.
    Handles Chinese, English, and mixed content.
    """
    if not text or not text.strip():
        return LanguageProfile(
            language=Language.UNKNOWN,
            cjk_ratio=0.0,
            ascii_ratio=0.0,
            char_count=0,
            cjk_count=0,
        )

    # Count meaningful characters (skip whitespace and basic punctuation)
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return LanguageProfile(
            language=Language.UNKNOWN,
            cjk_ratio=0.0,
            ascii_ratio=0.0,
            char_count=0,
            cjk_count=0,
        )

    total = len(chars)
    cjk_count = sum(1 for c in chars if _is_cjk(c))
    ascii_count = sum(1 for c in chars if ord(c) < 128)

    cjk_ratio = cjk_count / total
    ascii_ratio = ascii_count / total

    if cjk_ratio > 0.3:
        language = Language.CHINESE
    elif cjk_ratio > 0.1:
        language = Language.MIXED
    elif ascii_ratio > 0.7:
        language = Language.ENGLISH
    else:
        language = Language.UNKNOWN

    return LanguageProfile(
        language=language,
        cjk_ratio=round(cjk_ratio, 4),
        ascii_ratio=round(ascii_ratio, 4),
        char_count=total,
        cjk_count=cjk_count,
    )


def estimate_tokens(text: str, lang_profile: LanguageProfile | None = None) -> int:
    """Estimate token count for text.

    CJK text typically has ~1.5 tokens per character.
    English text typically has ~1 token per 4 characters.
    Uses tiktoken if available, otherwise falls back to heuristic.
    """
    if not text:
        return 0

    try:
        import tiktoken
        enc = tiktoken.encoding_for_model("gpt-4")
        return len(enc.encode(text))
    except (ImportError, Exception):
        pass

    # Heuristic fallback
    if lang_profile is None:
        lang_profile = detect_language(text)

    cjk_chars = sum(1 for c in text if _is_cjk(c))
    non_cjk = text
    for c in text:
        if _is_cjk(c):
            non_cjk = non_cjk.replace(c, "", 1)

    # CJK: ~1.5 tokens per character; English: ~1 token per 4 chars
    cjk_tokens = int(cjk_chars * 1.5)
    en_tokens = len(non_cjk.split())

    return cjk_tokens + en_tokens


def get_compression_params_for_language(lang_profile: LanguageProfile) -> dict:
    """Return language-specific compression parameters.

    Chinese text needs higher retention rates and different force tokens
    to preserve meaning (characters are more information-dense).
    """
    base_force_tokens = ["\n", ".", ",", ":", ";", "?", "!", "-", "#", "*", "|", "(", ")"]

    if lang_profile.is_cjk_dominant:
        # CJK text is denser — each character carries more meaning
        # Use higher minimum rate and add CJK punctuation to force tokens
        cn_force_tokens = list(_CN_PUNCTUATION)
        return {
            "min_rate": 0.6,
            "rate_boost": 0.15,  # Add to requested rate for CJK
            "force_tokens": base_force_tokens + cn_force_tokens,
            "description": "CJK-dominant: higher retention to preserve character-level meaning",
        }
    elif lang_profile.is_mixed:
        cn_force_tokens = ["，", "。", "！", "？", "：", "；"]
        return {
            "min_rate": 0.5,
            "rate_boost": 0.1,
            "force_tokens": base_force_tokens + cn_force_tokens,
            "description": "Mixed EN/CJK: moderate retention boost",
        }
    else:
        return {
            "min_rate": 0.3,
            "rate_boost": 0.0,
            "force_tokens": base_force_tokens + ["1", "2", "3", "4", "5", "6"],
            "description": "English-dominant: standard compression",
        }
