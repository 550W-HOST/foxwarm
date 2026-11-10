#!/usr/bin/env bash
# Install a POSIX server package into a disposable directory, then exercise
# start, HTTP sign-in page, status, forced reinstall through update, and stop.
# Usage: scripts/release/smoke-server.sh PACKAGE [PORT] [--without-tmux]
set -euo pipefail

package="${1:?Usage: smoke-server.sh PACKAGE [PORT] [--without-tmux]}"
package="$(cd "$(dirname "$package")" && pwd -P)/$(basename "$package")"
port="${2:-3001}"
installer="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/install-foxwarm.sh"
# Darwin's long per-user TMPDIR can exceed the Unix socket path limit in tmux.
work="$(mktemp -d /tmp/foxwarm-smoke.XXXXXX)"
if [ "${3:-}" = --without-tmux ]; then
  [ "$(uname -s)" = Darwin ] || { echo "--without-tmux requires the macOS system PATH" >&2; exit 1; }
  mkdir "$work/bin"
  case "$package" in
    *-self-contained.tar.gz|*-native.tar.gz) unset DOTNET_ROOT DOTNET_ROOT_ARM64 ;;
    *) if command -v dotnet >/dev/null 2>&1; then ln -s "$(command -v dotnet)" "$work/bin/dotnet"; fi ;;
  esac
  export PATH="$work/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  ! command -v tmux || { echo "tmux must be absent from the smoke PATH" >&2; exit 1; }
  case "$package" in *-self-contained.tar.gz|*-native.tar.gz) ! command -v dotnet ;; esac
fi
export FOXWARM_TMUX_SESSION="foxwarm-smoke-$$"
# Use a private tmux server, never the caller's.
unset TMUX
export TMUX_TMPDIR="$work"
control="$work/foxwarm/foxwarmctl"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && command -v tmux >/dev/null && tmux has-session -t "=$FOXWARM_TMUX_SESSION" 2>/dev/null; then
    tmux capture-pane -p -S -200 -t "=$FOXWARM_TMUX_SESSION:=foxwarm" || true
  fi
  if [ "$status" -ne 0 ]; then
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

mkdir -p "$work/data/state"
printf 'bot:\n  httpPort: %s\n' "$port" > "$work/data/state/config.yaml"
(cd "$work" && /bin/bash "$installer" --package "$package" --dir foxwarm --data-dir data)
wait_http
[ -s "$work/data/state/token" ] || { echo "No sign-in token was created" >&2; exit 1; }
"$control" status
first="$("$control" status | sed -n 's/.*Running (PID \([0-9]*\)).*/\1/p')"
[ -n "$first" ]
if [ "${3:-}" = --without-tmux ]; then
  [ "$(cat "$work/foxwarm/foxwarm.pid")" = "$first" ]
  [ -f "$work/data/state/logs/foxwarm.stdout.log" ]
  [ -f "$work/data/state/logs/foxwarm.stderr.log" ]
fi
[ -s "$work/data/state/logs/foxwarm.log" ] || { echo "No Main file log was created" >&2; exit 1; }

# A native package is a NativeAOT executable: no managed assembly, and no CLR in Main.
if grep -q '"native": true' "$work/foxwarm/runtime/current/release.json"; then
  [ ! -e "$work/foxwarm/runtime/current/Foxwarm.dll" ] || { echo "A native package must not contain Foxwarm.dll" >&2; exit 1; }
  if [ -r "/proc/$first/maps" ] && grep -q libcoreclr "/proc/$first/maps"; then
    echo "The native Main loaded CoreCLR" >&2; exit 1
  fi
fi

"$control" update --package "$package" --force
wait_http
second="$("$control" status | sed -n 's/.*Running (PID \([0-9]*\)).*/\1/p')"
[ -n "$second" ]
[ "$first" != "$second" ] || { echo "Update did not restart Foxwarm" >&2; exit 1; }
[ "$(find "$work/foxwarm/runtime" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ] || { ls -la "$work/foxwarm/runtime" >&2; echo "Old releases were not removed" >&2; exit 1; }

"$control" stop
if "$control" status; then echo "Foxwarm is still running after stop" >&2; exit 1; fi
state="$(ps -o stat= -p "$second" 2>/dev/null || true)"
[ -n "$state" ] && [ "${state#Z}" = "$state" ] && { echo "PID $second survived stop ($state)" >&2; exit 1; }
"$control" version
echo "Smoke test passed: $(basename "$package")"
