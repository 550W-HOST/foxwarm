#!/usr/bin/env python3
"""Create, verify, and restore Git-friendly SQLite chunk snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

FORMAT = "foxwarm-sqlite-chunks-v1"
DEFAULT_CHUNK_SIZE = 1024 * 1024
MAX_CHUNK_SIZE = 1024 * 1024
MAX_CHUNK_COUNT = 1_000_000
MAX_SQLITE_SIZE = (1 << 63) - 1
MAX_MANIFEST_BYTES = 4096
CHUNK_RE = re.compile(r"chunk-([0-9]{8})\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
V1_ROOT_ENTRIES = {"manifest.json", "chunks"}
LEGACY_ROOT_ENTRIES = {"size", "chunk-size", "sha256", "chunks"}


class SnapshotError(RuntimeError):
    """A malformed, corrupt, or unsafe snapshot."""


@dataclass(frozen=True)
class SnapshotSpec:
    format: str
    size: int
    chunk_size: int
    chunk_count: int
    sha256: str


def _fail(message: str) -> NoReturn:
    raise SnapshotError(message)


def _is_plain_dir(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(mode) and not stat.S_ISLNK(mode)


def _is_plain_file(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    return stat.S_ISREG(mode) and not stat.S_ISLNK(mode)


def _require_plain_dir(path: Path, label: str) -> None:
    if not _is_plain_dir(path):
        _fail(f"{label} is missing, not a directory, or a symlink: {path}")


def _require_plain_file(path: Path, label: str) -> None:
    if not _is_plain_file(path):
        _fail(f"{label} is missing, not a regular file, or a symlink: {path}")


def _exact_entry_names(path: Path, expected: set[str], label: str) -> None:
    _require_plain_dir(path, label)
    with os.scandir(path) as entries:
        actual = {entry.name for entry in entries}
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        _fail(f"{label} entries do not match the format (missing={missing}, extra={extra})")


def _strict_json_object(path: Path) -> dict[str, object]:
    _require_plain_file(path, "manifest")
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        _fail("manifest is too large")

    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                _fail(f"duplicate manifest key: {key}")
            result[key] = value
        return result

    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        _fail(f"invalid manifest JSON: {error}")
    if not isinstance(value, dict):
        _fail("manifest must be a JSON object")
    return value


def _bounded_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _fail(f"manifest {name} must be an integer from {minimum} to {maximum}")
    return value


def _parse_v1(snapshot: Path) -> SnapshotSpec:
    _exact_entry_names(snapshot, V1_ROOT_ENTRIES, "snapshot directory")
    manifest = _strict_json_object(snapshot / "manifest.json")
    expected_keys = {"format", "size", "chunk_size", "chunk_count", "sha256"}
    if set(manifest) != expected_keys:
        _fail(
            "manifest keys do not match the v1 schema "
            f"(missing={sorted(expected_keys - set(manifest))}, "
            f"extra={sorted(set(manifest) - expected_keys)})"
        )
    if manifest["format"] != FORMAT:
        _fail(f"unsupported snapshot format: {manifest['format']!r}")
    size = _bounded_int(manifest["size"], "size", 1, MAX_SQLITE_SIZE)
    chunk_size = _bounded_int(manifest["chunk_size"], "chunk_size", 1, MAX_CHUNK_SIZE)
    chunk_count = _bounded_int(manifest["chunk_count"], "chunk_count", 1, MAX_CHUNK_COUNT)
    digest = manifest["sha256"]
    if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
        _fail("manifest sha256 must be 64 lowercase hexadecimal characters")
    return SnapshotSpec(FORMAT, size, chunk_size, chunk_count, digest)


def _read_legacy_text(path: Path, label: str) -> str:
    _require_plain_file(path, label)
    if path.stat().st_size > 128:
        _fail(f"legacy {label} metadata is too large")
    try:
        text = path.read_text(encoding="ascii")
    except (OSError, UnicodeError) as error:
        _fail(f"invalid legacy {label}: {error}")
    if not text.endswith("\n") or "\n" in text[:-1] or not text[:-1]:
        _fail(f"legacy {label} must contain exactly one non-empty line")
    return text[:-1]


def _parse_legacy(snapshot: Path) -> SnapshotSpec:
    _exact_entry_names(snapshot, LEGACY_ROOT_ENTRIES, "legacy snapshot directory")
    size_text = _read_legacy_text(snapshot / "size", "size")
    chunk_size_text = _read_legacy_text(snapshot / "chunk-size", "chunk-size")
    digest = _read_legacy_text(snapshot / "sha256", "sha256")
    if not size_text.isascii() or not size_text.isdecimal():
        _fail("legacy size must be an unsigned decimal integer")
    if not chunk_size_text.isascii() or not chunk_size_text.isdecimal():
        _fail("legacy chunk-size must be an unsigned decimal integer")
    size = _bounded_int(int(size_text), "size", 1, MAX_SQLITE_SIZE)
    chunk_size = _bounded_int(int(chunk_size_text), "chunk_size", 1, MAX_CHUNK_SIZE)
    if SHA256_RE.fullmatch(digest) is None:
        _fail("legacy sha256 must be 64 lowercase hexadecimal characters")

    chunks = snapshot / "chunks"
    _require_plain_dir(chunks, "chunks directory")
    with os.scandir(chunks) as entries:
        names = [entry.name for entry in entries]
    if not names:
        _fail("snapshot has no chunks")
    if len(names) > MAX_CHUNK_COUNT:
        _fail("snapshot has too many chunks")
    for name in names:
        if CHUNK_RE.fullmatch(name) is None:
            _fail(f"invalid chunk entry name: {name}")
    count = len(names)
    expected = {f"chunk-{index:08d}" for index in range(count)}
    if set(names) != expected:
        _fail("legacy chunks are not one contiguous zero-based sequence")
    return SnapshotSpec("foxwarm-sqlite-chunks-legacy-unversioned", size, chunk_size, count, digest)


def _load_spec(snapshot: Path) -> SnapshotSpec:
    _require_plain_dir(snapshot, "snapshot directory")
    manifest = snapshot / "manifest.json"
    if _is_plain_file(manifest):
        spec = _parse_v1(snapshot)
    else:
        spec = _parse_legacy(snapshot)
    _validate_chunk_layout(snapshot, spec)
    return spec


def _validate_chunk_layout(snapshot: Path, spec: SnapshotSpec) -> None:
    chunks = snapshot / "chunks"
    _require_plain_dir(chunks, "chunks directory")
    actual_names: set[str] = set()
    with os.scandir(chunks) as entries:
        for entry in entries:
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                _fail(f"chunk payload contains a non-regular file or symlink: {entry.name}")
            if CHUNK_RE.fullmatch(entry.name) is None:
                _fail(f"invalid chunk entry name: {entry.name}")
            actual_names.add(entry.name)
    expected_names = {f"chunk-{index:08d}" for index in range(spec.chunk_count)}
    if actual_names != expected_names:
        _fail(
            "chunk payload does not match the manifest "
            f"(missing={sorted(expected_names - actual_names)[:5]}, "
            f"extra={sorted(actual_names - expected_names)[:5]})"
        )

    total = 0
    for index in range(spec.chunk_count):
        chunk = chunks / f"chunk-{index:08d}"
        _require_plain_file(chunk, f"chunk {index}")
        size = chunk.stat().st_size
        if index + 1 < spec.chunk_count and size != spec.chunk_size:
            _fail(f"non-final chunk {index} has size {size}, expected {spec.chunk_size}")
        if index + 1 == spec.chunk_count and not 1 <= size <= spec.chunk_size:
            _fail(f"final chunk has invalid size: {size}")
        total += size
    if total != spec.size:
        _fail(f"chunk payload size {total} does not match manifest size {spec.size}")


def _copy_chunks(snapshot: Path, spec: SnapshotSpec, destination: Path) -> None:
    digest = hashlib.sha256()
    total = 0
    with destination.open("wb") as output:
        for index in range(spec.chunk_count):
            chunk = snapshot / "chunks" / f"chunk-{index:08d}"
            _require_plain_file(chunk, f"chunk {index}")
            with chunk.open("rb") as source:
                while block := source.read(1024 * 1024):
                    output.write(block)
                    digest.update(block)
                    total += len(block)
        output.flush()
        os.fsync(output.fileno())
    if total != spec.size:
        _fail(f"rebuilt size {total} does not match manifest size {spec.size}")
    if digest.hexdigest() != spec.sha256:
        _fail("rebuilt SQLite SHA-256 does not match the manifest")


def _sqlite_uri(path: Path) -> str:
    return path.resolve().as_uri() + "?mode=ro"


def _check_sqlite(path: Path) -> None:
    try:
        connection = sqlite3.connect(_sqlite_uri(path), uri=True)
        try:
            integrity_rows = connection.execute("PRAGMA integrity_check").fetchall()
            if integrity_rows != [("ok",)]:
                _fail(f"SQLite integrity_check failed: {integrity_rows[:5]!r}")
            foreign_key_rows = connection.execute("PRAGMA foreign_key_check").fetchmany(6)
            if foreign_key_rows:
                _fail(f"SQLite foreign_key_check failed: {foreign_key_rows[:5]!r}")
        finally:
            connection.close()
    except SnapshotError:
        raise
    except sqlite3.Error as error:
        _fail(f"rebuilt file is not a valid SQLite database: {error}")


def verify_snapshot(snapshot_dir: os.PathLike[str] | str) -> SnapshotSpec:
    snapshot = Path(snapshot_dir)
    spec = _load_spec(snapshot)
    with tempfile.TemporaryDirectory(prefix="foxwarm-sqlite-verify-") as temporary:
        rebuilt = Path(temporary) / "rebuilt.sqlite"
        _copy_chunks(snapshot, spec, rebuilt)
        _check_sqlite(rebuilt)
    return spec


def _ensure_new_destination(path: Path, label: str) -> None:
    if path.exists() or path.is_symlink():
        _fail(f"{label} already exists: {path}")
    _require_plain_dir(path.parent, f"{label} parent")


def _write_chunks(source: Path, representation: Path, chunk_size: int) -> SnapshotSpec:
    chunks = representation / "chunks"
    chunks.mkdir(parents=True, mode=0o700)
    digest = hashlib.sha256()
    total = 0
    count = 0
    with source.open("rb") as input_file:
        while block := input_file.read(chunk_size):
            chunk = chunks / f"chunk-{count:08d}"
            with chunk.open("xb") as output:
                output.write(block)
                output.flush()
                os.fsync(output.fileno())
            chunk.chmod(0o600)
            digest.update(block)
            total += len(block)
            count += 1
            if count > MAX_CHUNK_COUNT:
                _fail("SQLite snapshot requires too many chunks")
    if total < 1 or count < 1:
        _fail("SQLite snapshot is empty")
    spec = SnapshotSpec(FORMAT, total, chunk_size, count, digest.hexdigest())
    manifest = {
        "format": spec.format,
        "size": spec.size,
        "chunk_size": spec.chunk_size,
        "chunk_count": spec.chunk_count,
        "sha256": spec.sha256,
    }
    manifest_path = representation / "manifest.json"
    with manifest_path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(manifest, output, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    manifest_path.chmod(0o600)
    return spec


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create_snapshot(
    source_db: os.PathLike[str] | str,
    snapshot_dir: os.PathLike[str] | str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> SnapshotSpec:
    source = Path(source_db)
    target = Path(snapshot_dir)
    _require_plain_file(source, "source SQLite database")
    if not 1 <= chunk_size <= MAX_CHUNK_SIZE:
        _fail(f"chunk size must be from 1 to {MAX_CHUNK_SIZE} bytes")
    _ensure_new_destination(target, "snapshot destination")

    temporary = Path(tempfile.mkdtemp(prefix=".foxwarm-sqlite-create-", dir=target.parent))
    try:
        captured = temporary / "captured.sqlite"
        representation = temporary / "representation"
        representation.mkdir(mode=0o700)
        try:
            source_connection = sqlite3.connect(_sqlite_uri(source), uri=True)
            destination_connection = sqlite3.connect(captured)
            try:
                source_connection.backup(destination_connection)
            finally:
                destination_connection.close()
                source_connection.close()
        except sqlite3.Error as error:
            _fail(f"SQLite online backup failed: {error}")
        _write_chunks(captured, representation, chunk_size)
        spec = verify_snapshot(representation)
        _fsync_directory(representation / "chunks")
        _fsync_directory(representation)
        _ensure_new_destination(target, "snapshot destination")
        os.rename(representation, target)
        _fsync_directory(target.parent)
        return spec
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def restore_snapshot(
    snapshot_dir: os.PathLike[str] | str,
    new_db_path: os.PathLike[str] | str,
) -> SnapshotSpec:
    snapshot = Path(snapshot_dir)
    destination = Path(new_db_path)
    _ensure_new_destination(destination, "restore destination")
    spec = _load_spec(snapshot)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.restore-", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        _copy_chunks(snapshot, spec, temporary)
        _check_sqlite(temporary)
        _ensure_new_destination(destination, "restore destination")
        os.rename(temporary, destination)
        _fsync_directory(destination.parent)
        return spec
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="create and verify a v1 chunk snapshot")
    create.add_argument("source_db", type=Path)
    create.add_argument("snapshot_dir", type=Path)
    create.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, metavar="BYTES")

    verify = subparsers.add_parser("verify", help="verify a v1 or legacy chunk snapshot")
    verify.add_argument("snapshot_dir", type=Path)

    restore = subparsers.add_parser("restore", help="restore to a new SQLite database path")
    restore.add_argument("snapshot_dir", type=Path)
    restore.add_argument("new_db_path", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = _build_parser().parse_args(argv)
    try:
        if arguments.command == "create":
            spec = create_snapshot(arguments.source_db, arguments.snapshot_dir, arguments.chunk_size)
            print(f"Created and verified {spec.format} snapshot: {arguments.snapshot_dir}")
        elif arguments.command == "verify":
            spec = verify_snapshot(arguments.snapshot_dir)
            print(f"Verified {spec.format} snapshot: {arguments.snapshot_dir}")
        else:
            spec = restore_snapshot(arguments.snapshot_dir, arguments.new_db_path)
            print(f"Restored and verified {spec.format} snapshot: {arguments.new_db_path}")
    except SnapshotError as error:
        print(f"sqlite-chunks: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
