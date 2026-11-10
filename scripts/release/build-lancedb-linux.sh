#!/usr/bin/env bash
# Build the Linux x64 LanceDB library (liblancedb_ffi.so) from the source pinned in
# dotnet/Foxwarm.LanceDb/source.json: the same lancedb-csharp commit whose C# binding Foxwarm
# compiles, with its locked Rust dependencies and release profile. The release workflow runs
# this in lancedb-linux.Dockerfile (glibc 2.34) and passes the result to package.mjs with
# --lancedb-library. Requires Rust (the source's pinned toolchain), protoc, a C/C++ compiler,
# cmake, curl and Python 3.
# Usage: scripts/release/build-lancedb-linux.sh OUTPUT_DIRECTORY
set -euo pipefail
output="$(mkdir -p "${1:?Usage: build-lancedb-linux.sh OUTPUT_DIRECTORY}" && cd "$1" && pwd)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
read -r archive sha256 commit < <(python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(s["archive"], s["sha256"], s["commit"])' "$root/dotnet/Foxwarm.LanceDb/source.json")
curl -fsSL --retry 3 -o "$work/source.tar.gz" "$archive"
echo "$sha256  $work/source.tar.gz" | sha256sum -c -
tar -xzf "$work/source.tar.gz" -C "$work"
source="$work/lancedb-csharp-$commit/pinvoke"
export CARGO_HOME="${CARGO_HOME:-$work/cargo}"
cargo build --release --locked --manifest-path "$source/Cargo.toml"
cp "$source/target/release/liblancedb_ffi.so" "$output/liblancedb_ffi.so"
printf '%s\n' "$commit" > "$output/lancedb-source-commit"
ldd --version | head -1
objdump -T "$output/liblancedb_ffi.so" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
