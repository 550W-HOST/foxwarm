#!/usr/bin/env python3
"""Packaging contracts only; these synthetic inputs do not qualify a native binary."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("native_package", ROOT / "scripts/native-aot/package-cli.py")
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fw-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.publish = self.root / "publish"
        (self.publish / "notices").mkdir(parents=True)
        executable = self.publish / "Foxwarm.CliNode"
        executable.write_bytes(b"synthetic executable input\n")
        executable.chmod(0o755)
        (self.publish / "BUILD-INPUTS.txt").write_text("synthetic toolchain inventory\n")
        for name in pack.NOTICES:
            (self.publish / "notices" / name).write_text("synthetic notice fixture\n")
        # These must never enter the distribution or its static-asset manifest.
        (self.publish / "Foxwarm.CliNode.dbg").write_text("debug")
        (self.publish / "credentials.json").write_text("not for distribution")
        (self.publish / "libfoxwarm-pty.so").write_text("not a static package input")
        self.output = self.root / "output"

    def package(self):
        return pack.package(self.publish, self.output, "a" * 40, 1700000000, "synthetic-build")

    def test_archive_contents_permissions_provenance_and_single_alias(self):
        archive = self.package()
        self.assertEqual(list((self.output / "assets/downloads").iterdir()), [archive])
        result = json.loads((self.output / "package-result.json").read_text())
        self.assertEqual(result["bytes"], archive.stat().st_size)
        self.assertLessEqual(result["bytes"], pack.LIMIT)
        with tarfile.open(archive) as tar:
            files = [item for item in tar.getmembers() if item.isfile()]
            expected = {"Foxwarm.CliNode", "LICENSE", "README.md", "BUILD-INFO.json", "BUILD-INPUTS.txt"}
            expected.update("notices/" + name for name in (*pack.NOTICES, "README.md"))
            self.assertEqual({str(Path(item.name).relative_to(pack.PACKAGE)) for item in files}, expected)
            executable = tar.getmember(pack.PACKAGE + "/Foxwarm.CliNode")
            self.assertEqual(executable.mode, 0o755)
            self.assertEqual(tar.extractfile(executable).read(), b"synthetic executable input\n")
            self.assertTrue(all(item.mode == 0o644 for item in files if item != executable))
            self.assertTrue(all(item.uid == 0 and item.gid == 0 and item.mtime == 1700000000 for item in files))
            info = json.load(tar.extractfile(pack.PACKAGE + "/BUILD-INFO.json"))
            self.assertEqual(info["sourceCommit"], "a" * 40)
            self.assertEqual(info["runtimeIdentifier"], "linux-musl-x64")
            self.assertEqual(info["nodeProtocol"], {"min": 1, "max": 3})
            destination = self.root / "extracted"
            tar.extractall(destination, filter="data")
        self.assertEqual((destination / pack.PACKAGE / "Foxwarm.CliNode").stat().st_mode & 0o777, 0o755)

    def test_complete_archive_limit_prevents_staging(self):
        with patch.object(pack, "LIMIT", 1):
            with self.assertRaisesRegex(ValueError, "exceeds Workers"):
                self.package()
        self.assertFalse((self.output / "assets").exists())

    def test_missing_required_notice_prevents_packaging(self):
        (self.publish / "notices/ICU-LICENSE.txt").unlink()
        with self.assertRaisesRegex(ValueError, "ICU-LICENSE"):
            self.package()
        self.assertFalse(self.output.exists())

    def test_existing_asset_stage_is_not_silently_overwritten(self):
        assets = self.output / "assets"
        assets.mkdir(parents=True)
        sentinel = assets / "existing"
        sentinel.write_text("retained asset")
        with self.assertRaisesRegex(ValueError, "fresh output"):
            self.package()
        self.assertEqual(sentinel.read_text(), "retained asset")

    def test_download_worker_owns_only_the_download_route(self):
        path = ROOT / "scripts/native-aot/downloads.wrangler.json"
        config = json.loads(path.read_text())
        self.assertNotIn("main", config)
        self.assertNotIn("account_id", config)
        self.assertNotIn("run_worker_first", config["assets"])
        self.assertEqual(config["routes"], [{"pattern": "foxwarm.550w.host/downloads/*", "zone_name": "550w.host"}])
        self.assertEqual(config["assets"]["not_found_handling"], "none")
        self.assertEqual(config["assets"]["html_handling"], "none")
        self.assertEqual((path.parent / config["assets"]["directory"]).resolve(), ROOT / ".temp/native-cli-downloads/assets")
        self.assertNotEqual(config["name"], "foxwarm-preview")


if __name__ == "__main__":
    unittest.main()
