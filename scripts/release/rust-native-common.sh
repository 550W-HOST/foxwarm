# Shared by build-lancedb.sh and build-monty.sh (sourced, not run). Builds the Rust libraries and
# executables Foxwarm ships from pinned, patched upstream sources, on Linux x64 (glibc 2.34 in
# rust-native-linux.Dockerfile), Windows x64 (MSVC, from Git Bash) and macOS arm64.
# Requires Rust via rustup, protoc (PROTOC or on PATH), the platform's C compiler, git, curl-free
# Python 3 and, for the licence file, network access to the crates registry.
release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python="$(command -v python3 || command -v python)"
case "$(uname -s)" in
  Linux)
    triple=x86_64-unknown-linux-gnu; lancedb_file=liblancedb_ffi.so; monty_file=monty
    # panic is set to abort, so unwind tables only add size.
    native_flags="-C force-unwind-tables=no" ;;
  Darwin)
    triple=aarch64-apple-darwin; lancedb_file=liblancedb_ffi.dylib; monty_file=monty
    native_flags="" ;;
  MINGW*|MSYS*|CYGWIN*)
    # python3 on a Windows runner can be the Microsoft Store stub.
    python=python
    triple=x86_64-pc-windows-msvc; lancedb_file=lancedb_ffi.dll; monty_file=monty.exe
    # Link the C runtime statically so the binaries need no Visual C++ redistributable.
    native_flags="-C target-feature=+crt-static" ;;
  *) echo "Unsupported build platform: $(uname -s)" >&2; exit 1 ;;
esac
native_work="$(mktemp -d)"
trap 'rm -rf -- "$native_work"' EXIT
export CARGO_HOME="${CARGO_HOME:-$native_work/cargo}"
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }$native_flags"

# native_prepare SOURCE_JSON PATCH DIRECTORY: fetch, verify and patch the source; select the toolchain.
native_prepare() {
  toolchain="$("$python" "$release_root/scripts/release/native-source.py" prepare "$1" "$native_work/$3" --patch "$2" | tail -1 | tr -d '\r')"
  source="$native_work/$3"
  [ -n "$toolchain" ] || { echo "No Rust toolchain is pinned for $3" >&2; exit 1; }
  rustup run "$toolchain" rustc --version >/dev/null 2>&1 \
    || rustup toolchain install "$toolchain" --profile minimal --no-self-update
  export RUSTUP_TOOLCHAIN="$toolchain"
  rustc --version
}
