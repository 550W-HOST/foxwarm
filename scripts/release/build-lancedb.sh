#!/usr/bin/env bash
# Build the LanceDB native library (liblancedb_ffi.so, lancedb_ffi.dll or liblancedb_ffi.dylib)
# from the source pinned in dotnet/Foxwarm.LanceDb/source.json, with the build configuration of
# dotnet/Foxwarm.LanceDb/native-build.patch: no object-store back ends and size optimization.
# Foxwarm opens only local-directory tables, so the upstream FFI crate's aws, azure, gcs, oss,
# dynamodb and huggingface features are never used. The release workflow runs this natively on
# Windows and macOS and in rust-native-linux.Dockerfile (glibc 2.34) on Linux, and passes the
# directory to scripts/release/package.mjs with --native-libraries.
# Usage: scripts/release/build-lancedb.sh OUTPUT_DIRECTORY
set -euo pipefail
output="$(mkdir -p "${1:?Usage: build-lancedb.sh OUTPUT_DIRECTORY}" && cd "$1" && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/rust-native-common.sh"
native_prepare "$release_root/dotnet/Foxwarm.LanceDb/source.json" "$release_root/dotnet/Foxwarm.LanceDb/native-build.patch" lancedb
manifest="$source/pinvoke/Cargo.toml"
"$python" "$release_root/scripts/release/native-source.py" prune-lock "$manifest"
export CARGO_TARGET_DIR="$native_work/target"
cargo build --release --locked --manifest-path "$manifest"
cp "$CARGO_TARGET_DIR/release/$lancedb_file" "$output/$lancedb_file"
"$python" "$release_root/scripts/release/crate-licenses.py" "$manifest" lancedb-ffi "$triple" \
  "$output/LanceDB-native-crates.txt" "Rust crates linked into the LanceDB native library"
"$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$release_root/dotnet/Foxwarm.LanceDb/source.json" > "$output/lancedb-source-commit"
ls -l "$output/$lancedb_file"
