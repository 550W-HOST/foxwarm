#!/usr/bin/env bash
# Install OLD_PACKAGE with the real installer and start it, then rerun the installer with
# NEW_PACKAGE (and any installer options, such as --native) to switch the installation the way
# users do. The installation's own control script performs the update. Checks that the new
# package runs from the same program directory and keeps its data and configuration.
# With --via-update ASSET, the installation's own `foxwarmctl update` performs the switch instead:
# its release downloads are answered with NEW_PACKAGE published under ASSET and a SHA256SUMS
# line for that name, and ASSET must be the asset the installed release records. Control
# scripts have a fixed release URL, so a curl wrapper on PATH serves those downloads; other
# requests use curl.
# A control script skips a package whose version it already runs unless forced, and the
# installer forces only a change of package type. When the installer path would upgrade to
# the installed version (a run of an unreleased version against the previous release's
# number), the script gives a copy of NEW_PACKAGE a distinct version in its release.json.
# Usage: scripts/release/smoke-upgrade.sh [--via-update ASSET] OLD_PACKAGE NEW_PACKAGE [PORT] [INSTALLER_OPTION...]
set -euo pipefail
via_update=""
if [ "${1:-}" = --via-update ]; then via_update="${2:?--via-update requires an asset name}"; shift 2; fi

absolute() { printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"; }
old="$(absolute "${1:?Usage: smoke-upgrade.sh OLD_PACKAGE NEW_PACKAGE [PORT] [INSTALLER_OPTION...]}")"
new="$(absolute "${2:?Usage: smoke-upgrade.sh OLD_PACKAGE NEW_PACKAGE [PORT] [INSTALLER_OPTION...]}")"
new_name="$(basename "$new")"
port="${3:-3001}"
shift 2; [ $# -eq 0 ] || shift
installer="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/install-foxwarm.sh"
work="$(mktemp -d /tmp/foxwarm-upgrade.XXXXXX)"
export FOXWARM_TMUX_SESSION="foxwarm-upgrade-$$"
unset TMUX FOXWARM_DATA_DIR FOXWARM_DIR
export TMUX_TMPDIR="$work"
control="$work/foxwarm/foxwarmctl"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    if command -v tmux >/dev/null && tmux has-session -t "=$FOXWARM_TMUX_SESSION" 2>/dev/null; then
      tmux capture-pane -p -S -200 -t "=$FOXWARM_TMUX_SESSION:=foxwarm" || true
    fi
    for file in "$work/data/state/logs/"*.log; do [ ! -f "$file" ] || tail -100 "$file"; done
  fi
  [ -x "$control" ] && "$control" stop >/dev/null 2>&1 || true
  tmux kill-server 2>/dev/null || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT

wait_http() {
  for ((attempt = 0; attempt < 120; attempt++)); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/login.html"; then return 0; fi
    sleep 0.5
  done
  echo "Foxwarm did not serve the sign-in page on port $port" >&2
  return 1
}
field() { sed -n "s/^ *\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$work/foxwarm/runtime/current/release.json" | sed -n 1p; }
running_pid() { "$control" status | sed -n 's/.*Running (PID \([0-9]*\)).*/\1/p'; }

mkdir -p "$work/data/state"
printf 'bot:\n  httpPort: %s\n# retained by the upgrade\n' "$port" > "$work/data/state/config.yaml"
(cd "$work" && /bin/bash "$installer" --package "$old" --dir foxwarm --data-dir data)
wait_http
before="$(field asset)"
before_release="$(field asset)/$(field version)/$(field commit)"
first="$(running_pid)"
[ -n "$first" ]
token="$(cat "$work/data/state/token")"
[ -n "$token" ]
config="$(cat "$work/data/state/config.yaml")"
printf 'kept\n' > "$work/data/agents/upgrade-marker"

# bsdtar has no --wildcards: name the release.json member of the package's top-level directory.
package_field() {
  tar -xzOf "$new" "$(tar -tzf "$new" | sed -n 's#^\([^/]*/release\.json\)$#\1#p' | sed -n 1p)" \
    | sed -n "s/^ *\"$1\": *\"\([^\"]*\)\".*/\1/p"
}
if [ -n "$via_update" ]; then
  serve="$work/release-download"
  mkdir -p "$serve" "$work/bin"
  cp "$new" "$serve/$via_update"
  if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
  (cd "$serve" && "${sum[@]}" "$via_update" > SHA256SUMS)
  real_curl="$(command -v curl)"
  {
    echo '#!/bin/bash'
    echo 'url=""; out=""; args=("$@")'
    echo 'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac; done'
    echo 'case "$url" in'
    echo '  https://github.com/*/releases/latest/download/*)'
    printf '    echo "$url" >> %q\n' "$work/requests"
    printf '    file=%q/"${url##*/}"\n' "$serve"
    echo '    [ -f "$file" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }'
    echo '    cp "$file" "$out" ;;'
    echo '  https://*) echo "Unexpected download: $url" >&2; exit 22 ;;'
    printf '  *) exec %q "${args[@]}" ;;\n' "$real_curl"
    echo 'esac'
  } > "$work/bin/curl"
  chmod +x "$work/bin/curl"
  # A release whose version equals the installed one needs --force; the download is the same.
  same=()
  [ "$(package_field version)" != "$(field version)" ] || same=(--force)
  PATH="$work/bin:$PATH" "$control" update ${same[@]+"${same[@]}"}
  expected="$(printf 'https://github.com/550W-HOST/foxwarm/releases/latest/download/%s\n' "$via_update" SHA256SUMS)"
  [ "$(cat "$work/requests")" = "$expected" ] \
    || { cat "$work/requests" >&2; echo "update did not download $via_update and its SHA256SUMS" >&2; exit 1; }
else
  if [ "$(package_field version)" = "$(field version)" ] && [ "$(package_field asset)" = "$before" ]; then
    mkdir "$work/repack"
    tar -xzpf "$new" -C "$work/repack"
    directory="$(find "$work/repack" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    sed "s/^\( *\"version\": *\"[^\"]*\)\"/\1-upgrade-smoke\"/" "$directory/release.json" > "$work/release.json"
    cp "$work/release.json" "$directory/release.json"
    new="$work/package-upgrade-smoke.tar.gz"
    tar -czf "$new" -C "$work/repack" "$(basename "$directory")"
    echo "The package has the installed version; upgrading to $(package_field version) instead."
  fi
  (cd "$work" && /bin/bash "$installer" --package "$new" --dir foxwarm ${@+"$@"})
fi
wait_http
second="$(running_pid)"
[ -n "$second" ] && [ "$first" != "$second" ] || { echo "The installer did not restart Foxwarm on the new package" >&2; exit 1; }
after="$(field asset)"
after_release="$after/$(field version)/$(field commit)"
echo "Switched $before_release -> $after_release"
[ "$after_release" != "$before_release" ] || { echo "The installation still runs $before_release" >&2; exit 1; }
[ "$(cat "$work/data/state/token")" = "$token" ] || { echo "The sign-in token changed" >&2; exit 1; }
[ "$(cat "$work/data/state/config.yaml")" = "$config" ] || { echo "config.yaml changed" >&2; exit 1; }
[ "$(cat "$work/data/agents/upgrade-marker")" = kept ] || { echo "Agent data was lost" >&2; exit 1; }
[ "$(cat "$work/foxwarm/data_dir")" = "$(cd "$work/data" && pwd -P)" ] || { echo "data_dir changed" >&2; exit 1; }
args="$(ps -ww -o args= -p "$second")"
if [ "$(field native)" = true ]; then
  case "$args" in *Foxwarm.dll*|*dotnet*) echo "The native installation runs a managed Main: $args" >&2; exit 1 ;; esac
  [ ! -e "$work/foxwarm/runtime/current/Foxwarm.dll" ] || { echo "The native package contains Foxwarm.dll" >&2; exit 1; }
fi
# Later updates must request the new package's own asset, not the name it arrived under.
[ "$after" = "$(package_field asset)" ] || { echo "release.json records $after, not $(package_field asset)" >&2; exit 1; }
[ "$(find "$work/foxwarm/runtime" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ] || { ls -la "$work/foxwarm/runtime" >&2; echo "The old release was not removed" >&2; exit 1; }
"$control" restart
wait_http
"$control" stop
if "$control" status; then echo "Foxwarm is still running after stop" >&2; exit 1; fi
echo "Upgrade smoke passed: $(basename "$old") -> $new_name"
