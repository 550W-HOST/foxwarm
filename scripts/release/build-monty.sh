#!/usr/bin/env bash
# Build the ToolScript worker executable (monty or monty.exe) from the source pinned in
# dotnet/Foxwarm/ToolScript/monty-source.json (pydantic/monty v0.0.19) with
# dotnet/Foxwarm/ToolScript/monty-no-type-check.patch, which leaves out the ty type checker that
# Foxwarm never uses. The release workflow runs this like build-lancedb.sh.
# Usage: scripts/release/build-monty.sh OUTPUT_DIRECTORY
set -euo pipefail
output="$(mkdir -p "${1:?Usage: build-monty.sh OUTPUT_DIRECTORY}" && cd "$1" && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/rust-native-common.sh"
native_prepare "$release_root/dotnet/Foxwarm/ToolScript/monty-source.json" "$release_root/dotnet/Foxwarm/ToolScript/monty-no-type-check.patch" monty
manifest="$source/Cargo.toml"
"$python" "$release_root/scripts/release/native-source.py" prune-lock "$manifest"
export CARGO_TARGET_DIR="$native_work/target"
# The release profile's own settings (fat LTO, one codegen unit, speed optimization) stay; the
# interpreter loop is the product, and size optimization slows it measurably. Aborting on panic
# is safe: nothing in the worker catches an unwind.
export CARGO_PROFILE_RELEASE_PANIC=abort
cargo build --release --locked --manifest-path "$manifest" -p monty-runtime
cp "$CARGO_TARGET_DIR/release/$monty_file" "$output/$monty_file"
"$python" "$release_root/scripts/release/crate-licenses.py" "$manifest" monty-runtime "$triple" \
  "$output/Monty-native-crates.txt" "Rust crates linked into the Monty worker executable"
"$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$release_root/dotnet/Foxwarm/ToolScript/monty-source.json" > "$output/monty-source-commit"
ls -l "$output/$monty_file"
