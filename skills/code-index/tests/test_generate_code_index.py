#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "generate_code_index_standalone.py"
SPEC = importlib.util.spec_from_file_location("generate_code_index", MODULE_PATH)
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


class GeneratorSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.output = self.root / "output"
        self.source.mkdir()
        self.output.mkdir()
        (self.source / "src").mkdir()
        (self.source / "src" / "safe.ts").write_text("export function safe() {}\n", encoding="utf-8")
        (self.source / "src" / "other.ts").write_text("export const other = 1;\n", encoding="utf-8")
        self.file_list = [
            {"path": "src/other.ts", "lines": 1},
            {"path": "src/safe.ts", "lines": 1},
        ]

    def tearDown(self):
        self.temp.cleanup()

    def test_groupings_reject_absolute_parent_unknown_and_malicious_names(self):
        cases = [
            [{"name": "safe", "files": ["/etc/hostname", "src/other.ts"]}],
            [{"name": "safe", "files": ["../outside.ts", "src/other.ts"]}],
            [{"name": "safe", "files": ["src/missing.ts", "src/other.ts"]}],
            [{"name": "../../escape", "files": ["src/safe.ts", "src/other.ts"]}],
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(generator.ValidationError):
                generator.validate_groupings(value, self.source, self.file_list)

    def test_groupings_require_exactly_one_assignment_for_every_scanned_file(self):
        with self.assertRaisesRegex(generator.ValidationError, "omitted"):
            generator.validate_groupings(
                [{"name": "safe", "files": ["src/safe.ts"]}], self.source, self.file_list,
            )
        with self.assertRaisesRegex(generator.ValidationError, "multiple units"):
            generator.validate_groupings([
                {"name": "safe", "files": ["src/safe.ts"]},
                {"name": "other", "files": ["src/safe.ts", "src/other.ts"]},
            ], self.source, self.file_list)

    def test_scan_filter_rejects_files_outside_scanned_allowlist(self):
        with mock.patch.object(generator, "list_candidate_paths", return_value=["src/safe.ts", "src/other.ts"]):
            selected = generator.scan_files(self.source, ["src/safe.ts"])
            self.assertEqual([item["path"] for item in selected], ["src/safe.ts"])
            with self.assertRaises(generator.ValidationError):
                generator.scan_files(self.source, ["/etc/hostname"])

    def test_empty_or_failed_model_response_never_creates_unit_document(self):
        groupings = [{"name": "safe", "files": ["src/safe.ts"], "description": "safe"}]
        with mock.patch.object(generator, "call_model", return_value=""):
            with self.assertRaises(generator.ModelCallError):
                generator.generate_units(groupings, self.source, self.output)
        self.assertFalse((self.output / "units" / "safe.md").exists())

        with mock.patch.object(generator, "call_model", side_effect=generator.ModelCallError("failed")):
            with self.assertRaises(generator.ModelCallError):
                generator.generate_units(groupings, self.source, self.output)
        self.assertFalse((self.output / "units" / "safe.md").exists())

    def test_cache_fingerprint_covers_source_file_list_project_and_model(self):
        cache = self.output / "_work" / "groupings.json"
        groupings = [{"name": "safe", "files": ["src/safe.ts", "src/other.ts"], "description": "safe"}]
        inputs = generator.grouping_cache_inputs(self.source, self.file_list, "project", "model-a")
        generator.save_groupings_cache(cache, inputs, groupings)
        self.assertEqual(
            generator.load_groupings_cache(cache, inputs, self.source, self.file_list), groupings,
        )

        changed_files = self.file_list + [{"path": "new.ts", "lines": 2}]
        changed_inputs = generator.grouping_cache_inputs(self.source, changed_files, "project", "model-a")
        self.assertIsNone(generator.load_groupings_cache(cache, changed_inputs, self.source, changed_files))
        changed_model = generator.grouping_cache_inputs(self.source, self.file_list, "project", "model-b")
        self.assertIsNone(generator.load_groupings_cache(cache, changed_model, self.source, self.file_list))

        payload = json.loads(cache.read_text(encoding="utf-8"))
        self.assertEqual(payload["inputs"]["phase"], "groupings")
        self.assertEqual(payload["inputs"]["source"], str(self.source.resolve()))

    def test_existing_docs_are_preserved_without_force_and_replaced_with_force(self):
        target = self.output / "modules" / "core.md"
        target.parent.mkdir()
        target.write_text("# Existing\n\n## Design Decisions\n- keep me\n", encoding="utf-8")
        self.assertFalse(generator.write_generated_doc(target, "replacement", force=False))
        self.assertIn("keep me", target.read_text(encoding="utf-8"))
        self.assertTrue(generator.write_generated_doc(target, "replacement\n", force=True))
        self.assertEqual(target.read_text(encoding="utf-8"), "replacement\n")

    def test_existing_module_phase_is_preserved_without_any_model_call(self):
        units = self.output / "units"
        modules = self.output / "modules"
        units.mkdir()
        modules.mkdir()
        (units / "safe.md").write_text("# Unit: safe\n", encoding="utf-8")
        existing = modules / "core.md"
        existing.write_text("# Existing\n\n## Design Decisions\n- keep me\n", encoding="utf-8")
        with mock.patch.object(generator, "call_model") as call_model:
            result = generator.generate_modules(self.output)
        call_model.assert_not_called()
        self.assertEqual(result, [{"name": "core", "path": str(existing)}])
        self.assertIn("keep me", existing.read_text(encoding="utf-8"))

    def test_empty_existing_doc_requires_explicit_force(self):
        target = self.output / "units" / "empty.md"
        target.parent.mkdir()
        target.touch()
        with self.assertRaises(generator.GeneratorError):
            generator.write_generated_doc(target, "new\n", force=False)
        self.assertEqual(target.stat().st_size, 0)
        generator.write_generated_doc(target, "new\n", force=True)
        self.assertEqual(target.read_text(encoding="utf-8"), "new\n")

    def test_module_and_thread_names_are_strict_slugs(self):
        with self.assertRaises(generator.ValidationError):
            generator.validate_module_plan(
                [{"name": "../escape", "units": ["safe.md"]}], ["safe.md"],
            )
        with self.assertRaises(generator.ValidationError):
            generator.parse_threads("===THREAD: ../../escape===\ntext\n===END===")

    def test_atomic_write_leaves_complete_content(self):
        target = self.output / "nested" / "doc.md"
        generator.atomic_write_text(target, "complete\n")
        self.assertEqual(target.read_text(encoding="utf-8"), "complete\n")
        self.assertEqual(list(target.parent.glob(".*.tmp")), [])

    def test_output_subdirectory_symlink_cannot_escape_output_root(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.output / "units").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(generator.ValidationError):
            generator.ensure_output_directory(self.output, "units")


if __name__ == "__main__":
    unittest.main()
