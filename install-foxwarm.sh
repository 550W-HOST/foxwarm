#!/usr/bin/env bash
# Install a prebuilt Foxwarm release on Linux x64 or macOS arm64 and start it.
#   curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
set -euo pipefail

RELEASES="https://github.com/550W-HOST/foxwarm/releases"
CALL_DIR="$PWD"
VERSION=""
PACKAGE=""
VARIANT=""
START=true

log() { printf '\033[1;34m[foxwarm-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[foxwarm-install]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[foxwarm-install]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Usage: install-foxwarm.sh [options]

  --dir PATH             Program directory (default: ./foxwarm)
  --data-dir PATH        Data directory (default: saved selection, otherwise ./foxwarm-data)
  --version VERSION      Install this release instead of the latest
  --native               Use the native package, which needs no .NET (default)
  --framework-dependent  Use the package that needs the installed ASP.NET Core 10 runtime
  --package FILE         Install a downloaded package instead of downloading one
  --no-start             Install without starting Foxwarm

A new installation uses the native package unless chosen. Choosing a package for
an existing installation, or passing a package file of another type, switches it
to that package and keeps its data.
Environment: FOXWARM_DIR, FOXWARM_DATA_DIR, FOXWARM_TMUX_SESSION.
EOF
}

# Download a release file; a release that does not publish it fails with that message.
download() {
  local code=""
  if have curl; then
    code="$(curl -L --retry 3 -o "$2" -w '%{http_code}' "$1")" || fail "Could not download $1."
  else
    wget -q -O "$2" "$1" || fail "Could not download $1."
  fi
  case "$code" in
    ''|2??) ;;
    404) if [ -n "$VERSION" ]; then fail "Release $VERSION has no ${1##*/}."; else fail "The latest release has no ${1##*/}."; fi ;;
    *) fail "Could not download $1 (HTTP $code)." ;;
  esac
}

value() { [ $# -ge 2 ] || { echo "$1 requires a value" >&2; exit 2; }; printf '%s' "$2"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) FOXWARM_DIR="$(value "$@")"; shift 2 ;;
    --dir=*) FOXWARM_DIR="${1#--dir=}"; shift ;;
    --data-dir) FOXWARM_DATA_DIR="$(value "$@")"; shift 2 ;;
    --data-dir=*) FOXWARM_DATA_DIR="${1#--data-dir=}"; shift ;;
    --version) VERSION="$(value "$@")"; VERSION="${VERSION#v}"; shift 2 ;;
    --package) PACKAGE="$(value "$@")"; shift 2 ;;
    --native) VARIANT=native; shift ;;
    --self-contained) VARIANT=self-contained; shift ;;
    --framework-dependent) VARIANT=framework-dependent; shift ;;
    --no-start) START=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

trimmed_file() {
  local text
  text="$(cat "$1" 2>/dev/null || true)"
  text="${text#"${text%%[![:space:]]*}"}"
  printf '%s' "${text%"${text##*[![:space:]]}"}"
}

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    '~') printf '%s\n' "$HOME" ;;
    '~/'*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s/%s\n' "$2" "$1" ;;
  esac
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) RID=linux-x64 ;;
  Darwin-arm64) RID=osx-arm64 ;;
  Darwin-x86_64) fail "Foxwarm macOS server packages require Apple Silicon (arm64). Intel Macs are not supported." ;;
  *) fail "Foxwarm release packages support Linux x64, macOS arm64 and Windows x64." ;;
esac
have tar || fail "tar is required."
if have sha256sum; then checksum=(sha256sum); elif have shasum; then checksum=(shasum -a 256); else fail "sha256sum or shasum is required."; fi
[ -n "$PACKAGE" ] || have curl || have wget || fail "curl or wget is required."
# The native package replaced the self-contained one, which also needed no .NET: on
# Linux in 0.9.4, on macOS in 0.9.6.
RETIRED_ASSET="foxwarm-$RID-self-contained.tar.gz"
if [ "$VARIANT" = self-contained ]; then
  log "Self-contained packages were replaced by the native package; using it."
  VARIANT=native
fi
# Asset name of a package variant for this platform.
asset_for() {
  case "$1" in
    native) printf 'foxwarm-%s-native.tar.gz' "$RID" ;;
    self-contained) printf 'foxwarm-%s-self-contained.tar.gz' "$RID" ;;
    *) printf 'foxwarm-%s.tar.gz' "$RID" ;;
  esac
}
# Asset name recorded in a package archive's release.json (bsdtar has no --wildcards).
package_asset() {
  local member
  member="$(tar -tzf "$1" | sed -n 's#^\([^/]*/release\.json\)$#\1#p' | sed -n 1p)"
  [ -n "$member" ] || fail "$1 is not a Foxwarm server package."
  tar -xzOf "$1" "$member" | sed -n 's/^ *"asset": *"\([^"]*\)".*/\1/p' | sed -n 1p
}
# Linux needs system ICU and OpenSSL even for native and self-contained .NET. macOS
# uses its system ICU and Apple cryptography libraries; it does not use ldconfig.
if [ "$RID" = linux-x64 ]; then
  libraries="$(ldconfig -p 2>/dev/null || true)"
  for library in libicuuc libssl; do
    if have ldconfig && ! grep -q "$library\.so" <<<"$libraries"; then
      fail "$library is missing. Install ICU and OpenSSL with your package manager (for example: apt install libicu-dev libssl3, or dnf install libicu openssl-libs)."
    fi
  done
fi

FOXWARM_DIR="$(absolute_path "${FOXWARM_DIR:-foxwarm}" "$CALL_DIR")"
[ -n "$PACKAGE" ] && PACKAGE="$(absolute_path "$PACKAGE" "$CALL_DIR")"
if [ -e "$FOXWARM_DIR/.git" ]; then
  fail "$FOXWARM_DIR is a source checkout. Update it from source, or choose another --dir and pass --data-dir to reuse its data."
fi

# Print where to sign in once Foxwarm is running (the start command has already confirmed it).
show_signin() {
  local data="$1" token="" port i
  for ((i = 1; i <= 120; i++)); do
    if [ -s "$data/state/token" ]; then token="$(cat "$data/state/token")"; break; fi
    [ $((i % 20)) -eq 0 ] && warn "Still waiting for startup. Inspect it with: '$FOXWARM_DIR/foxwarmctl' status"
    sleep 0.5
  done
  # config.yaml may not exist yet; under pipefail the failed sed must not end the installer.
  port="$(sed -n 's/^ *httpPort: *\([0-9][0-9]*\).*/\1/p' "$data/state/config.yaml" 2>/dev/null | sed -n 1p || true)"
  port="${port:-3001}"
  echo
  echo "Program dir: $FOXWARM_DIR"
  echo "Data dir:    $data"
  if [ -n "$token" ]; then
    echo "WebUI: http://localhost:${port}/#token=${token}"
  else
    warn "The sign-in token is not ready yet. When startup finishes, read it with: cat '$data/state/token'"
    echo "WebUI: http://localhost:${port}/"
  fi
  echo
  echo "Control: '$FOXWARM_DIR/foxwarmctl' status | stop | restart | update | attach"
}

if [ -e "$FOXWARM_DIR/runtime/current/release.json" ]; then
  if [ -n "${FOXWARM_DATA_DIR:-}" ]; then
    saved="$(trimmed_file "$FOXWARM_DIR/data_dir")"
    requested="$(absolute_path "$FOXWARM_DATA_DIR" "$CALL_DIR")"
    if [ -z "$saved" ] || [ "$(cd "$requested" 2>/dev/null && pwd -P)" != "$(cd "$(absolute_path "$saved" "$FOXWARM_DIR")" 2>/dev/null && pwd -P)" ]; then
      fail "$FOXWARM_DIR already uses the data directory in its data_dir file. Stop Foxwarm and edit that file to change it."
    fi
  fi
  log "Foxwarm is already installed in $FOXWARM_DIR; updating it."
  args=()
  installed="$(sed -n 's/^ *"asset": *"\([^"]*\)".*/\1/p' "$FOXWARM_DIR/runtime/current/release.json")"
  wanted="$installed"
  if [ -n "$VARIANT" ]; then
    wanted="$(asset_for "$VARIANT")"
  elif [ -n "$PACKAGE" ]; then
    # A package file of another type is a choice of that package.
    wanted="$(package_asset "$PACKAGE")"
  elif [ "$installed" = "$RETIRED_ASSET" ]; then
    wanted="$(asset_for native)"
  fi
  if [ "$wanted" != "$installed" ]; then
    # The installed control script updates within its own package type, so this
    # switch downloads the chosen package here and hands it over as a file.
    # --force also switches between packages of the same version.
    log "Switching $FOXWARM_DIR from $installed to $wanted."
    args+=(--force)
    if [ -z "$PACKAGE" ]; then
      SCRATCH="$(mktemp -d "$FOXWARM_DIR/runtime/.staging-XXXXXX")"
      trap 'rm -rf -- "$SCRATCH"' EXIT
      if [ -n "$VERSION" ]; then base="$RELEASES/download/v$VERSION"; else base="$RELEASES/latest/download"; fi
      log "Downloading $wanted${VERSION:+ $VERSION}"
      download "$base/$wanted" "$SCRATCH/$wanted"
      download "$base/SHA256SUMS" "$SCRATCH/SHA256SUMS"
      (cd "$SCRATCH" && grep -E "  $wanted\$" SHA256SUMS | "${checksum[@]}" -c -) || fail "Checksum verification failed for $wanted."
      PACKAGE="$SCRATCH/$wanted"
    fi
  fi
  [ -n "$PACKAGE" ] && args+=(--package "$PACKAGE")
  [ -n "$VERSION" ] && args+=("$VERSION")
  "$FOXWARM_DIR/foxwarmctl" update ${args[@]+"${args[@]}"}
  if [ "$START" = true ]; then
    if ! "$FOXWARM_DIR/foxwarmctl" status >/dev/null; then "$FOXWARM_DIR/foxwarmctl" start; fi
    show_signin "$(absolute_path "$(trimmed_file "$FOXWARM_DIR/data_dir")" "$FOXWARM_DIR")"
  fi
  exit 0
fi

if [ -n "${FOXWARM_DATA_DIR:-}" ]; then
  FOXWARM_DATA_DIR="$(absolute_path "$FOXWARM_DATA_DIR" "$CALL_DIR")"
else
  saved="$(trimmed_file "$FOXWARM_DIR/data_dir")"
  if [ -n "$saved" ]; then
    FOXWARM_DATA_DIR="$(absolute_path "$saved" "$FOXWARM_DIR")"
  else
    FOXWARM_DATA_DIR="$(dirname "$FOXWARM_DIR")/foxwarm-data"
  fi
fi

if [ -z "$VARIANT" ] && [ -z "$PACKAGE" ]; then
  VARIANT=native
  log "Using the native package, which needs no .NET runtime."
fi
ASSET="$(asset_for "$VARIANT")"

mkdir -p "$FOXWARM_DIR/runtime"
SCRATCH="$(mktemp -d "$FOXWARM_DIR/runtime/.staging-XXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT

if [ -z "$PACKAGE" ]; then
  if [ -n "$VERSION" ]; then base="$RELEASES/download/v$VERSION"; else base="$RELEASES/latest/download"; fi
  log "Downloading $ASSET${VERSION:+ $VERSION}"
  download "$base/$ASSET" "$SCRATCH/$ASSET"
  download "$base/SHA256SUMS" "$SCRATCH/SHA256SUMS"
  (cd "$SCRATCH" && grep -E "  $ASSET\$" SHA256SUMS | "${checksum[@]}" -c -) || fail "Checksum verification failed for $ASSET."
  PACKAGE="$SCRATCH/$ASSET"
fi
mkdir "$SCRATCH/extract"
tar -xzf "$PACKAGE" -C "$SCRATCH/extract"
STAGING="$(find "$SCRATCH/extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[ -n "$STAGING" ] && [ -x "$STAGING/Foxwarm" ] && [ -x "$STAGING/foxwarmctl" ] || fail "$PACKAGE is not a Foxwarm server package."
package_rid="$(sed -n 's/^ *"rid": *"\([^"]*\)".*/\1/p' "$STAGING/release.json")"
[ "$package_rid" = "$RID" ] || fail "$PACKAGE is for $package_rid, not $RID."
RELEASE="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$STAGING/release.json")"

mkdir -p "$FOXWARM_DATA_DIR/state" "$FOXWARM_DATA_DIR/agents"
FOXWARM_DATA_DIR="$(cd "$FOXWARM_DATA_DIR" && pwd -P)"
printf '%s\n' "$FOXWARM_DATA_DIR" > "$FOXWARM_DIR/data_dir"
export FOXWARM_DATA_DIR
log "Checking existing data in $FOXWARM_DATA_DIR"
if grep -q '"selfContained": true' "$STAGING/release.json"; then
  inspect=("$STAGING/Foxwarm")
else
  have dotnet || fail "This package needs the ASP.NET Core 10 runtime and dotnet on PATH; use the native package otherwise."
  inspect=(dotnet "$STAGING/Foxwarm.dll")
fi
"${inspect[@]}" --installation-root "$FOXWARM_DIR" --inspect-upgrade || fail "Upgrade inspection found a blocking problem; nothing was installed."
mv "$STAGING" "$FOXWARM_DIR/runtime/$RELEASE"
ln -sfn "$RELEASE" "$FOXWARM_DIR/runtime/current"
cp "$FOXWARM_DIR/runtime/current/foxwarmctl" "$FOXWARM_DIR/foxwarmctl"
log "Installed Foxwarm $RELEASE in $FOXWARM_DIR"

if [ "$START" = false ]; then
  echo "Start it with: '$FOXWARM_DIR/foxwarmctl' start"
  exit 0
fi
"$FOXWARM_DIR/foxwarmctl" start

show_signin "$FOXWARM_DATA_DIR"
