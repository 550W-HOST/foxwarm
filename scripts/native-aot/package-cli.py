#!/usr/bin/env python3
"""Package a complete native CLI target and its protocol-v3 download channel."""
import argparse
import gzip
import hashlib
import zipfile
import time
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

LIMIT = 25 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[2]
PACKAGE = "native-cli-node-linux-x64"
ALIAS = "native-cli-node-latest-v3.tar.gz"
NOTICES = (
    "dotnet-LICENSE.txt", "dotnet-NOTICES.txt", "aspnetcore-LICENSE.txt",
    "aspnetcore-NOTICES.txt", "PuppeteerSharp-LICENSE.txt",
    "ReactiveExtensionsSharp-LICENSE.txt", "RecyclableMemoryStream-LICENSE.txt",
    "musl-COPYRIGHT.txt", "ICU-LICENSE.txt", "OpenSSL-LICENSE.txt",
    "zlib-LICENSE.txt", "GCC-COPYING3.txt", "GCC-RUNTIME-EXCEPTION.txt", "SOURCES.txt",
)


def package(publish, output, source_commit, epoch, build_id, target="linux-musl-x64"):
    """Use only named release files, never the complete publish/debug directory."""
    if target not in ("linux-musl-x64", "win-x64", "osx-arm64"):
        raise ValueError(f"Unsupported native CLI target: {target}")
    linux = target == "linux-musl-x64"
    windows = target == "win-x64"
    package_name = PACKAGE if linux else "native-cli-node-" + target
    alias = ALIAS if linux else f"{package_name}-latest-v3." + ("zip" if windows else "tar.gz")
    notices = NOTICES if linux else (*NOTICES[:7], "SOURCES.txt")
    binaries = ["Foxwarm.CliNode.exe" if windows else "Foxwarm.CliNode"]
    if target == "osx-arm64":
        binaries += ["libfoxwarm-pty.dylib", "foxwarm-pty-helper"]
    publish, output = Path(publish), Path(output)
    executable = publish / binaries[0]
    inputs = publish / "BUILD-INPUTS.txt"
    for path in (inputs, *(publish / name for name in binaries), *(publish / "notices" / name for name in notices)):
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Required distribution input is missing or empty: {path}")
    if not windows and not os.access(executable, os.X_OK):
        raise ValueError("Foxwarm.CliNode must be executable")
    if epoch < 0:
        raise ValueError("Source timestamp must be nonnegative")
    output.mkdir(parents=True, exist_ok=True)
    # This directory belongs exclusively to the native publication workflow.
    # A fresh stage avoids unintentionally retaining an old channel or debug file.
    assets = output / "assets"
    if assets.exists():
        raise ValueError(f"Use a fresh output directory; asset stage already exists: {assets}")
    with tempfile.TemporaryDirectory(prefix="fw-native-package-") as temporary:
        stage = Path(temporary) / package_name
        stage.mkdir()
        for name in binaries:
            shutil.copyfile(publish / name, stage / name)
            (stage / name).chmod(0o755)
        shutil.copyfile(ROOT / "LICENSE", stage / "LICENSE")
        shutil.copyfile(ROOT / ("scripts/native-aot/PACKAGE-README.md" if linux else "scripts/native-aot/PLATFORM-PACKAGE-README.md"), stage / "README.md")
        shutil.copyfile(inputs, stage / "BUILD-INPUTS.txt")
        (stage / "notices").mkdir()
        for name in notices:
            shutil.copyfile(publish / "notices" / name, stage / "notices" / name)
        shutil.copyfile(ROOT / "scripts/native-aot/NOTICE.md", stage / "notices/README.md")
        provenance = {
            "sourceCommit": source_commit,
            "sourceTimestamp": epoch,
            "buildId": build_id,
            "productVersion": json.loads((ROOT / "package.json").read_text())["version"],
            "runtimeIdentifier": target,
            "platform": "Linux x64" if linux else target,
            "nodeProtocol": {"min": 1, "max": 3},
            "publishedAlias": alias,
        }
        (stage / "BUILD-INFO.json").write_text(json.dumps(provenance, indent=2) + "\n")
        archive = Path(temporary) / alias
        if windows:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
                for path in sorted(stage.rglob("*")):
                    if path.is_file():
                        info = zipfile.ZipInfo(path.relative_to(stage.parent).as_posix(), time.gmtime(max(epoch, 315532800))[:6])
                        info.compress_type = zipfile.ZIP_DEFLATED
                        info.external_attr = (0o100755 if path.name in binaries else 0o100644) << 16
                        zipped.writestr(info, path.read_bytes())
        else:
            with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch, compresslevel=9) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
                    for path in (stage, *sorted(stage.rglob("*"))):
                        info = tar.gettarinfo(str(path), arcname=str(path.relative_to(stage.parent)))
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        info.mtime = epoch
                        info.mode = 0o755 if path.is_dir() or path.name in binaries else 0o644
                        if path.is_file():
                            with path.open("rb") as source:
                                tar.addfile(info, source)
                        else:
                            tar.addfile(info)
        size = archive.stat().st_size
        print(f"Complete package: {size} bytes; Workers limit: {LIMIT} bytes", flush=True)
        if size > LIMIT:
            raise ValueError(f"Complete package exceeds Workers' per-file limit by {size - LIMIT} bytes")
        target = assets / "downloads" / alias
        target.parent.mkdir(parents=True)
        shutil.copyfile(archive, target)
        (target.parent / (alias + ".sha256")).write_text(hashlib.sha256(target.read_bytes()).hexdigest() + "  " + alias + "\n")
        (output / "package-result.json").write_text(json.dumps({
            "archive": str(target.relative_to(output)), "bytes": size,
            "limitBytes": LIMIT, "sourceCommit": source_commit,
        }, indent=2) + "\n")
        return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="linux-musl-x64", choices=["linux-musl-x64", "win-x64", "osx-arm64"])
    parser.add_argument("--publish", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-epoch", required=True, type=int)
    parser.add_argument("--build-id", required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if args.source_commit != commit:
        parser.error("Source commit must match this checkout's HEAD")
    print(package(args.publish, args.output, args.source_commit, args.source_epoch, args.build_id, args.target))


if __name__ == "__main__":
    main()
