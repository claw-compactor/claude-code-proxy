"""Tests for language detection module."""

import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.language import (
    Language,
    LanguageProfile,
    detect_language,
    estimate_tokens,
    get_compression_params_for_language,
)


class TestDetectLanguage:
    """Test language detection across EN, CN, and mixed content."""

    def test_empty_text(self):
        result = detect_language("")
        assert result.language == Language.UNKNOWN
        assert result.cjk_ratio == 0.0
        assert result.char_count == 0

    def test_whitespace_only(self):
        result = detect_language("   \n\t  ")
        assert result.language == Language.UNKNOWN

    def test_english_text(self):
        text = "This is a standard English paragraph about machine learning and AI."
        result = detect_language(text)
        assert result.language == Language.ENGLISH
        assert result.cjk_ratio < 0.1
        assert result.ascii_ratio > 0.7

    def test_chinese_text(self):
        text = "这是一段关于人工智能和机器学习的中文文本，用于测试语言检测功能。"
        result = detect_language(text)
        assert result.language == Language.CHINESE
        assert result.cjk_ratio > 0.3
        assert result.cjk_count > 0

    def test_mixed_text(self):
        text = "The model uses GPT-4进行推理，使用LLMLingua-2进行压缩。Performance is good。"
        result = detect_language(text)
        # Mixed or Chinese depending on ratio
        assert result.language in (Language.MIXED, Language.CHINESE)
        assert result.cjk_ratio > 0.0

    def test_technical_english(self):
        text = "def compress_prompt(text: str, rate: float = 0.5) -> dict:"
        result = detect_language(text)
        assert result.language == Language.ENGLISH

    def test_japanese_text(self):
        text = "これは日本語のテスト文です。"
        result = detect_language(text)
        # Japanese uses CJK ranges, should be detected
        assert result.cjk_count > 0

    def test_frozen_dataclass(self):
        """LanguageProfile should be immutable."""
        result = detect_language("Hello world")
        try:
            result.language = Language.CHINESE
            assert False, "Should not be able to mutate frozen dataclass"
        except AttributeError:
            pass  # Expected


class TestEstimateTokens:
    """Test token estimation."""

    def test_empty(self):
        assert estimate_tokens("") == 0

    def test_english_words(self):
        text = "Hello world this is a test"
        tokens = estimate_tokens(text)
        assert tokens > 0
        assert tokens <= 10  # ~6 words

    def test_chinese_text(self):
        text = "这是一个测试文本"
        tokens = estimate_tokens(text)
        assert tokens > 0
        # CJK tokens should be ~1.5x character count
        assert tokens >= 4

    def test_long_text(self):
        text = "word " * 200
        tokens = estimate_tokens(text)
        assert tokens >= 100


class TestCompressionParamsForLanguage:
    """Test language-specific compression parameters."""

    def test_english_params(self):
        profile = detect_language("This is English text for testing.")
        params = get_compression_params_for_language(profile)
        assert params["min_rate"] == 0.3
        assert params["rate_boost"] == 0.0
        assert "\n" in params["force_tokens"]

    def test_chinese_params(self):
        profile = detect_language("这是一段很长的中文文本，用于测试压缩参数配置。")
        params = get_compression_params_for_language(profile)
        assert params["min_rate"] == 0.6
        assert params["rate_boost"] == 0.15
        # Should include CJK punctuation
        assert "，" in params["force_tokens"]
        assert "。" in params["force_tokens"]

    def test_mixed_params(self):
        profile = LanguageProfile(
            language=Language.MIXED,
            cjk_ratio=0.2,
            ascii_ratio=0.6,
            char_count=100,
            cjk_count=20,
        )
        params = get_compression_params_for_language(profile)
        assert params["min_rate"] == 0.5
        assert params["rate_boost"] == 0.1
