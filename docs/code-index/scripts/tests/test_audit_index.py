#!/usr/bin/env python3
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "audit_index.py"
SPEC = importlib.util.spec_from_file_location("audit_index", MODULE_PATH)
audit_index = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = audit_index
SPEC.loader.exec_module(audit_index)

WARN_BYTES = 24 * 1024
ERROR_BYTES = 48 * 1024
HEADER = "# Large thread\n"


def ascii_document_of_bytes(size):
    return HEADER + "a" * (size - len(HEADER.encode("utf-8")))


class DocumentSizeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.index_root = Path(self.temp.name) / "code-index"
        self.source_root = Path(self.temp.name) / "source"
        (self.index_root / "threads").mkdir(parents=True)
        self.source_root.mkdir()
        (self.index_root / "overview.md").write_text("# Overview\n\n- [Large](threads/large.md)\n", encoding="utf-8")
        self.large = self.index_root / "threads" / "large.md"

    def tearDown(self):
        self.temp.cleanup()

    def write_document(self, text):
        self.large.write_text(text, encoding="utf-8")

    def size_findings(self):
        findings = audit_index.audit(self.index_root, self.source_root, False)
        return [(item.level, item.path) for item in findings if item.code == "file-size"]

    def test_warning_starts_only_above_24_kib(self):
        self.write_document(ascii_document_of_bytes(WARN_BYTES))
        self.assertEqual(self.size_findings(), [])

        self.write_document(ascii_document_of_bytes(WARN_BYTES + 1))
        self.assertEqual(self.size_findings(), [("WARN", "threads/large.md")])

    def test_error_starts_only_above_48_kib_and_replaces_the_warning(self):
        self.write_document(ascii_document_of_bytes(ERROR_BYTES))
        self.assertEqual(self.size_findings(), [("WARN", "threads/large.md")])

        self.write_document(ascii_document_of_bytes(ERROR_BYTES + 1))
        self.assertEqual(self.size_findings(), [("ERROR", "threads/large.md")])

    def test_size_counts_utf8_bytes_not_characters(self):
        # 9,000 characters occupy 27,000 UTF-8 bytes, above the warning limit.
        self.write_document(HEADER + "\u2014" * 9000)
        self.assertEqual(self.size_findings(), [("WARN", "threads/large.md")])

    def test_error_size_makes_the_command_fail(self):
        argv = ["audit_index.py", "--index-root", str(self.index_root), "--source-root", str(self.source_root)]
        self.write_document(ascii_document_of_bytes(WARN_BYTES + 1))
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(audit_index.main(), 0)

        self.write_document(ascii_document_of_bytes(ERROR_BYTES + 1))
        output = io.StringIO()
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
            self.assertEqual(audit_index.main(), 1)
        self.assertIn("file-size", output.getvalue())


if __name__ == "__main__":
    unittest.main()
