"""Tests for content density detection module."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.density import detect_content_density, smart_rate


class TestDetectContentDensity:
    """Test content density analysis."""

    def test_empty_text(self):
        result = detect_content_density("")
        assert not result.is_dense
        assert result.total_lines == 0

    def test_verbose_paragraph(self):
        text = (
            "This is a very long and verbose paragraph that goes on and on "
            "about nothing in particular. It contains many words per line and "
            "has no structural elements like lists or tables. The purpose of "
            "this text is to test that verbose natural language is correctly "
            "identified as non-dense content that can be compressed aggressively."
        )
        result = detect_content_density(text)
        assert not result.is_dense
        assert result.numbered_lines == 0
        assert result.bullet_lines == 0

    def test_numbered_list(self):
        text = """
1. First item in the list
2. Second item in the list
3. Third item in the list
4. Fourth item in the list
5. Fifth item in the list
"""
        result = detect_content_density(text)
        assert result.is_dense
        assert result.numbered_lines >= 5
        assert "structured" in result.reason

    def test_bullet_list(self):
        text = """
- Item one
- Item two
- Item three
- Item four
"""
        result = detect_content_density(text)
        assert result.is_dense
        assert result.bullet_lines >= 4

    def test_markdown_headers(self):
        text = """
# Header 1
Some content.

## Header 2
More content.

### Header 3
Even more content.
"""
        result = detect_content_density(text)
        assert result.header_lines >= 3

    def test_table_content(self):
        text = """
| Name | Value | Description |
|------|-------|-------------|
| foo  | 42    | A foo value |
| bar  | 99    | A bar value |
"""
        result = detect_content_density(text)
        assert result.is_dense
        assert result.table_lines >= 3

    def test_code_block(self):
        text = """
Here is some code:

```python
def hello():
    print("Hello, world!")
    return 42
```

End of example.
"""
        result = detect_content_density(text)
        assert result.code_lines >= 3

    def test_technical_content(self):
        text = (
            "LLMLingua-2 v3.4 uses XLM-RoBERTa-large for token-level pruning. "
            "The API endpoint /v1/chat/completions accepts JSON-RPC requests. "
            "GPU acceleration via CUDA 12.1 reduces latency from 500ms to 100ms. "
            "The OpenAI-compatible API supports streaming SSE responses. "
            "DeepSeek-V3 achieves MMLU score of 87.2% on GPT-4 level tasks."
        )
        result = detect_content_density(text)
        assert result.tech_ratio > 0.1

    def test_chinese_structured(self):
        text = """
1. 第一步：安装依赖
2. 第二步：配置环境
3. 第三步：运行测试
4. 第四步：部署上线
"""
        result = detect_content_density(text)
        assert result.is_dense
        assert result.numbered_lines >= 4


class TestSmartRate:
    """Test smart rate adjustment."""

    def test_verbose_no_adjustment(self):
        text = "This is a plain paragraph without any structure at all " * 10
        rate, density, adjusted = smart_rate(text, 0.3)
        assert rate == 0.3
        assert not adjusted

    def test_dense_content_clamped(self):
        text = "\n".join(f"{i}. Item number {i}" for i in range(1, 20))
        rate, density, adjusted = smart_rate(text, 0.3)
        assert rate == 0.6
        assert adjusted
        assert density.is_dense

    def test_dense_above_minimum_no_adjustment(self):
        text = "\n".join(f"{i}. Item number {i}" for i in range(1, 20))
        rate, density, adjusted = smart_rate(text, 0.7)
        assert rate == 0.7
        assert not adjusted
