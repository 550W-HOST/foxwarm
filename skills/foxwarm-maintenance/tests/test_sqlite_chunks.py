#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "sqlite-chunks.py"
SPEC = importlib.util.spec_from_file_location("foxwarm_sqlite_chunks", SCRIPT)
assert SPEC and SPEC.loader
sqlite_chunks = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sqlite_chunks
SPEC.loader.exec_module(sqlite_chunks)


class SqliteChunksTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def make_database(self, name: str = "source.sqlite", rows: int = 20) -> Path:
        path = self.root / name
        connection = sqlite3.connect(path)
        connection.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        connection.executemany(
            "INSERT INTO items(value) VALUES (?)",
            [(f"value-{index}-" + "x" * 1000,) for index in range(rows)],
        )
        connection.commit()
        connection.close()
        return path

    def assert_database_rows(self, path: Path, expected: int) -> None:
        connection = sqlite3.connect(path)
        try:
            self.assertEqual(connection.execute("SELECT count(*) FROM items").fetchone()[0], expected)
        finally:
            connection.close()

    def make_snapshot(self, name: str = "snapshot") -> Path:
        source = self.make_database(name=f"{name}-source.sqlite")
        snapshot = self.root / name
        sqlite_chunks.create_snapshot(source, snapshot, chunk_size=4096)
        return snapshot

    def make_legacy_snapshot(self) -> Path:
        source = self.make_database("legacy-source.sqlite")
        snapshot = self.root / "legacy"
        chunks = snapshot / "chunks"
        chunks.mkdir(parents=True)
        data = source.read_bytes()
        chunk_size = 4096
        for index, offset in enumerate(range(0, len(data), chunk_size)):
            (chunks / f"chunk-{index:08d}").write_bytes(data[offset : offset + chunk_size])
        (snapshot / "size").write_text(f"{len(data)}\n", encoding="ascii")
        (snapshot / "chunk-size").write_text(f"{chunk_size}\n", encoding="ascii")
        (snapshot / "sha256").write_text(
            hashlib.sha256(data).hexdigest() + "\n", encoding="ascii"
        )
        return snapshot

    def test_online_wal_create_verify_restore_round_trip(self) -> None:
        source = self.root / "wal.sqlite"
        connection = sqlite3.connect(source)
        self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        connection.executemany(
            "INSERT INTO items(value) VALUES (?)",
            [("online-" + "x" * 2000,) for _ in range(100)],
        )
        connection.commit()
        self.assertTrue(Path(str(source) + "-wal").exists())

        snapshot = self.root / "wal-snapshot"
        spec = sqlite_chunks.create_snapshot(source, snapshot, chunk_size=8192)
        self.assertEqual(spec.format, sqlite_chunks.FORMAT)
        self.assertEqual(sqlite_chunks.verify_snapshot(snapshot), spec)
        restored = self.root / "restored.sqlite"
        self.assertEqual(sqlite_chunks.restore_snapshot(snapshot, restored), spec)
        self.assert_database_rows(restored, 100)
        connection.close()

    def test_create_writes_only_v1_layout(self) -> None:
        snapshot = self.make_snapshot()
        self.assertEqual({item.name for item in snapshot.iterdir()}, {"manifest.json", "chunks"})
        manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["format"], sqlite_chunks.FORMAT)
        self.assertEqual(manifest["chunk_size"], 4096)
        self.assertGreater(manifest["chunk_count"], 1)
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((snapshot / "manifest.json").stat().st_mode), 0o600)
        self.assertTrue(
            all(stat.S_IMODE(chunk.stat().st_mode) == 0o600 for chunk in (snapshot / "chunks").iterdir())
        )

    def test_legacy_verify_and_restore(self) -> None:
        snapshot = self.make_legacy_snapshot()
        spec = sqlite_chunks.verify_snapshot(snapshot)
        self.assertEqual(spec.format, "foxwarm-sqlite-chunks-legacy-unversioned")
        restored = self.root / "legacy-restored.sqlite"
        sqlite_chunks.restore_snapshot(snapshot, restored)
        self.assert_database_rows(restored, 20)

    def test_corruption_is_rejected_and_restore_leaves_no_destination(self) -> None:
        snapshot = self.make_snapshot()
        first = snapshot / "chunks" / "chunk-00000000"
        data = bytearray(first.read_bytes())
        data[0] ^= 0xFF
        first.write_bytes(data)
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "SHA-256"):
            sqlite_chunks.verify_snapshot(snapshot)
        destination = self.root / "must-not-exist.sqlite"
        with self.assertRaises(sqlite_chunks.SnapshotError):
            sqlite_chunks.restore_snapshot(snapshot, destination)
        self.assertFalse(destination.exists())

    def test_missing_and_extra_chunks_are_rejected(self) -> None:
        missing = self.make_snapshot("missing")
        (missing / "chunks" / "chunk-00000000").unlink()
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "payload"):
            sqlite_chunks.verify_snapshot(missing)

        extra = self.make_snapshot("extra")
        (extra / "chunks" / "chunk-99999999").write_bytes(b"extra")
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "payload"):
            sqlite_chunks.verify_snapshot(extra)

    def test_extra_root_entry_and_manifest_schema_are_rejected(self) -> None:
        extra = self.make_snapshot("extra-root")
        (extra / "unexpected").write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "entries"):
            sqlite_chunks.verify_snapshot(extra)

        malformed = self.make_snapshot("manifest-extra")
        manifest_path = malformed / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["unexpected"] = True
        manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "schema"):
            sqlite_chunks.verify_snapshot(malformed)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are unavailable")
    def test_symlink_chunk_is_rejected(self) -> None:
        snapshot = self.make_snapshot()
        chunk = snapshot / "chunks" / "chunk-00000000"
        external = self.root / "external"
        external.write_bytes(chunk.read_bytes())
        chunk.unlink()
        chunk.symlink_to(external)
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "symlink"):
            sqlite_chunks.verify_snapshot(snapshot)

    def test_existing_destinations_are_refused(self) -> None:
        source = self.make_database()
        existing_snapshot = self.root / "existing-snapshot"
        existing_snapshot.mkdir()
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "already exists"):
            sqlite_chunks.create_snapshot(source, existing_snapshot)

        snapshot = self.root / "snapshot"
        sqlite_chunks.create_snapshot(source, snapshot)
        existing_restore = self.root / "existing.sqlite"
        existing_restore.write_bytes(b"do not replace")
        with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "already exists"):
            sqlite_chunks.restore_snapshot(snapshot, existing_restore)
        self.assertEqual(existing_restore.read_bytes(), b"do not replace")

    def test_create_failure_does_not_publish_partial_destination(self) -> None:
        source = self.make_database()
        target = self.root / "not-published"
        with mock.patch.object(
            sqlite_chunks,
            "verify_snapshot",
            side_effect=sqlite_chunks.SnapshotError("injected verification failure"),
        ):
            with self.assertRaisesRegex(sqlite_chunks.SnapshotError, "injected"):
                sqlite_chunks.create_snapshot(source, target, chunk_size=4096)
        self.assertFalse(target.exists())
        self.assertEqual(
            [entry for entry in self.root.iterdir() if entry.name.startswith(".foxwarm-sqlite-create-")],
            [],
        )

    def test_invalid_sqlite_source_does_not_publish(self) -> None:
        source = self.root / "not-sqlite"
        source.write_bytes(b"not a sqlite database")
        target = self.root / "invalid-target"
        with self.assertRaises(sqlite_chunks.SnapshotError):
            sqlite_chunks.create_snapshot(source, target)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
