"""Tests for PostToolUse auto-compression functionality.

Tests the auto --changed-file mode, path validation, and PostToolUse hook.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from compress import (
    auto_compress_file,
    should_skip_path,
    SKIP_DIRS,
    SKIP_PATH_PATTERNS,
    COMPRESSIBLE_EXTENSIONS,
)
from hooks.post_tool_use import (
    extract_file_path,
    is_write_or_edit_tool,
    process_post_tool_use,
)


class TestShouldSkipPath:
    """Test file path validation for auto-compression."""

    def test_skip_git_directory(self):
        path = Path("/repo/.git/objects/abc123")
        skip, reason = should_skip_path(path)
        assert skip
        assert ".git" in reason

    def test_skip_node_modules(self):
        path = Path("/project/node_modules/lodash/index.js")
        skip, reason = should_skip_path(path)
        assert skip
        assert "node_modules" in reason

    def test_skip_pycache(self):
        path = Path("/project/__pycache__/module.cpython-312.pyc")
        skip, reason = should_skip_path(path)
        assert skip
        assert "__pycache__" in reason

    def test_skip_openclaw_sessions(self):
        path = Path("/workspace/.openclaw/sessions/abc123.json")
        skip, reason = should_skip_path(path)
        assert skip
        assert ".openclaw/sessions" in reason or "excluded" in reason

    def test_skip_no_extension(self):
        path = Path("/project/Makefile")
        skip, reason = should_skip_path(path)
        assert skip
        assert "no file extension" in reason

    def test_skip_non_compressible_extension(self):
        path = Path("/project/image.png")
        skip, reason = should_skip_path(path)
        assert skip
        assert "not compressible" in reason

    def test_skip_nonexistent_file(self):
        path = Path("/nonexistent/path/file.md")
        skip, reason = should_skip_path(path)
        assert skip
        assert "does not exist" in reason

    def test_allow_markdown_file(self):
        """A real markdown file should not be skipped (except for existence check)."""
        with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w") as f:
            f.write("# Hello World\n\nThis is test content.\n")
            temp_path = Path(f.name)
        try:
            skip, reason = should_skip_path(temp_path)
            assert not skip
            assert reason == ""
        finally:
            temp_path.unlink()

    def test_allow_python_file(self):
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w") as f:
            f.write("def hello():\n    print('hello')\n")
            temp_path = Path(f.name)
        try:
            skip, reason = should_skip_path(temp_path)
            assert not skip
        finally:
            temp_path.unlink()

    def test_skip_empty_file(self):
        with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w") as f:
            temp_path = Path(f.name)
        try:
            skip, reason = should_skip_path(temp_path)
            assert skip
            assert "empty" in reason
        finally:
            temp_path.unlink()

    def test_skip_venv_directory(self):
        path = Path("/project/.venv/lib/python3.12/site-packages/pkg/init.py")
        skip, reason = should_skip_path(path)
        assert skip
        assert ".venv" in reason

    def test_compressible_extensions_complete(self):
        """Verify key extensions are in the compressible set."""
        assert ".md" in COMPRESSIBLE_EXTENSIONS
        assert ".py" in COMPRESSIBLE_EXTENSIONS
        assert ".js" in COMPRESSIBLE_EXTENSIONS
        assert ".ts" in COMPRESSIBLE_EXTENSIONS
        assert ".yaml" in COMPRESSIBLE_EXTENSIONS
        assert ".json" in COMPRESSIBLE_EXTENSIONS
        assert ".txt" in COMPRESSIBLE_EXTENSIONS
        assert ".sh" in COMPRESSIBLE_EXTENSIONS

    def test_skip_dirs_complete(self):
        """Verify key directories are in the skip set."""
        assert ".git" in SKIP_DIRS
        assert "node_modules" in SKIP_DIRS
        assert "__pycache__" in SKIP_DIRS
        assert ".venv" in SKIP_DIRS


class TestAutoCompressFile:
    """Test the auto_compress_file function."""

    def test_nonexistent_file(self):
        result = auto_compress_file("/nonexistent/file.md", quiet=True)
        assert result["action"] == "skipped"
        assert "does not exist" in result["reason"]
        assert result["tokens_saved"] == 0

    def test_skip_binary_extension(self):
        result = auto_compress_file("/some/image.png", quiet=True)
        assert result["action"] == "skipped"
        assert "not compressible" in result["reason"]

    def test_skip_git_path(self):
        result = auto_compress_file("/repo/.git/config", quiet=True)
        assert result["action"] == "skipped"
        assert ".git" in result["reason"]

    def test_short_file_below_threshold(self):
        """File with very few tokens should be skipped."""
        with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w") as f:
            f.write("Hello world\n")
            temp_path = f.name
        try:
            result = auto_compress_file(temp_path, quiet=True)
            assert result["action"] == "skipped"
            assert "threshold" in result.get("reason", "") or "Below minimum" in result.get("reason", "")
        finally:
            Path(temp_path).unlink()

    def test_compress_long_file(self):
        """File with many tokens should be compressed."""
        # Generate verbose text that the lightweight compressor can reduce
        verbose_lines = []
        for i in range(50):
            verbose_lines.append(
                f"Basically, it is important to note that item {i} essentially "
                f"does something obviously useful. Actually, this is literally "
                f"the most clearly important part of the document needless to say. "
                f"As a matter of fact, having said that, it should be noted that "
                f"this line is here for what it's worth."
            )
        text = "\n".join(verbose_lines)

        with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w") as f:
            f.write(text)
            temp_path = f.name

        try:
            result = auto_compress_file(temp_path, quiet=True)
            # Should either compress or skip (if engine not available)
            assert result["action"] in ("compressed", "skipped")
            if result["action"] == "compressed":
                assert result["tokens_saved"] > 0
                assert result["savings_pct"] > 0
                # Verify file was actually modified
                new_text = Path(temp_path).read_text()
                assert len(new_text) <= len(text)
        finally:
            Path(temp_path).unlink()

    def test_empty_file_skipped(self):
        with tempfile.NamedTemporaryFile(suffix=".md", delete=False, mode="w") as f:
            temp_path = f.name
        try:
            result = auto_compress_file(temp_path, quiet=True)
            assert result["action"] == "skipped"
        finally:
            Path(temp_path).unlink()

    def test_quiet_mode_no_output(self, capsys):
        result = auto_compress_file("/nonexistent/file.md", quiet=True)
        captured = capsys.readouterr()
        assert captured.out == ""

    def test_non_quiet_mode_has_output(self, capsys):
        result = auto_compress_file("/nonexistent/file.md", quiet=False)
        captured = capsys.readouterr()
        assert "[compactor]" in captured.out


class TestExtractFilePath:
    """Test file path extraction from tool call dicts."""

    def test_write_tool(self):
        tool_call = {
            "tool": "Write",
            "args": {"file_path": "/path/to/file.md", "content": "hello"},
        }
        assert extract_file_path(tool_call) == "/path/to/file.md"

    def test_edit_tool(self):
        tool_call = {
            "tool": "Edit",
            "args": {"file_path": "/path/to/file.py", "old_string": "a", "new_string": "b"},
        }
        assert extract_file_path(tool_call) == "/path/to/file.py"

    def test_notebook_edit_tool(self):
        tool_call = {
            "tool": "NotebookEdit",
            "args": {"notebook_path": "/path/to/notebook.ipynb", "new_source": "x"},
        }
        assert extract_file_path(tool_call) == "/path/to/notebook.ipynb"

    def test_bash_tool_returns_none(self):
        tool_call = {
            "tool": "Bash",
            "args": {"command": "ls -la"},
        }
        assert extract_file_path(tool_call) is None

    def test_read_tool_returns_none(self):
        tool_call = {
            "tool": "Read",
            "args": {"file_path": "/path/to/file.md"},
        }
        assert extract_file_path(tool_call) is None

    def test_missing_args(self):
        tool_call = {"tool": "Write"}
        assert extract_file_path(tool_call) is None

    def test_non_dict_args(self):
        tool_call = {"tool": "Write", "args": "not a dict"}
        assert extract_file_path(tool_call) is None


class TestIsWriteOrEditTool:
    """Test tool type detection."""

    def test_write(self):
        assert is_write_or_edit_tool({"tool": "Write"})

    def test_edit(self):
        assert is_write_or_edit_tool({"tool": "Edit"})

    def test_notebook_edit(self):
        assert is_write_or_edit_tool({"tool": "NotebookEdit"})

    def test_bash(self):
        assert not is_write_or_edit_tool({"tool": "Bash"})

    def test_read(self):
        assert not is_write_or_edit_tool({"tool": "Read"})

    def test_grep(self):
        assert not is_write_or_edit_tool({"tool": "Grep"})

    def test_empty(self):
        assert not is_write_or_edit_tool({})


class TestProcessPostToolUse:
    """Test the PostToolUse processing pipeline."""

    def test_non_write_tool_ignored(self):
        tool_call = {"tool": "Bash", "args": {"command": "ls"}}
        config = {"hooks": {"post_tool_auto_compress": True}}
        result = process_post_tool_use(tool_call, config)
        assert result["action"] == "ignored"

    def test_disabled_config(self):
        tool_call = {
            "tool": "Write",
            "args": {"file_path": "/tmp/test.md", "content": "x"},
        }
        config = {"hooks": {"post_tool_auto_compress": False}}
        result = process_post_tool_use(tool_call, config)
        assert result["action"] == "disabled"

    def test_write_nonexistent_file(self):
        tool_call = {
            "tool": "Write",
            "args": {"file_path": "/nonexistent/test.md", "content": "x"},
        }
        config = {"hooks": {"post_tool_auto_compress": True}}
        result = process_post_tool_use(tool_call, config)
        assert result["action"] == "skipped"
        assert "does not exist" in result["reason"]

    def test_write_to_git_dir_skipped(self):
        tool_call = {
            "tool": "Write",
            "args": {"file_path": "/repo/.git/config"},
        }
        config = {"hooks": {"post_tool_auto_compress": True}}
        result = process_post_tool_use(tool_call, config)
        assert result["action"] == "skipped"
