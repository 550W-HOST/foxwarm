#!/usr/bin/env bash
# Install OLD_PACKAGE with the real installer and start it, then rerun the installer with
# NEW_PACKAGE (and any installer options, such as --native) to switch the installation the way
# users do. The installation's own control script performs the update. Checks that the new
# package runs from the same program directory and keeps its data and configuration.
# Usage: scripts/release/smoke-upgrade.sh OLD_PACKAGE NEW_PACKAGE [PORT] [INSTALLER_OPTION...]
set -euo pipefail

absolute() { printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"; }
old="$(absolute "${1:?Usage: smoke-upgrade.sh OLD_PACKAGE NEW_PACKAGE [PORT] [INSTALLER_OPTION...]}")"
new="$(absolute "${2:?Usage: smoke-upgrade.sh OLD_PACKAGE NEW_PACKAGE [PORT] [INSTALLER_OPTION...]}")"
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
first="$(running_pid)"
[ -n "$first" ]
token="$(cat "$work/data/state/token")"
[ -n "$token" ]
config="$(cat "$work/data/state/config.yaml")"
printf 'kept\n' > "$work/data/agents/upgrade-marker"

(cd "$work" && /bin/bash "$installer" --package "$new" --dir foxwarm ${@+"$@"})
wait_http
second="$(running_pid)"
[ -n "$second" ] && [ "$first" != "$second" ] || { echo "The installer did not restart Foxwarm on the new package" >&2; exit 1; }
after="$(field asset)"
echo "Switched $before -> $after"
[ "$after" != "$before" ] || { echo "The installation still uses $before" >&2; exit 1; }
[ "$(cat "$work/data/state/token")" = "$token" ] || { echo "The sign-in token changed" >&2; exit 1; }
[ "$(cat "$work/data/state/config.yaml")" = "$config" ] || { echo "config.yaml changed" >&2; exit 1; }
[ "$(cat "$work/data/agents/upgrade-marker")" = kept ] || { echo "Agent data was lost" >&2; exit 1; }
[ "$(cat "$work/foxwarm/data_dir")" = "$(cd "$work/data" && pwd -P)" ] || { echo "data_dir changed" >&2; exit 1; }
args="$(ps -ww -o args= -p "$second")"
if [ "$(field native)" = true ]; then
  case "$args" in *Foxwarm.dll*|*dotnet*) echo "The native installation runs a managed Main: $args" >&2; exit 1 ;; esac
  [ ! -e "$work/foxwarm/runtime/current/Foxwarm.dll" ] || { echo "The native package contains Foxwarm.dll" >&2; exit 1; }
fi
[ "$(find "$work/foxwarm/runtime" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ] || { ls -la "$work/foxwarm/runtime" >&2; echo "The old release was not removed" >&2; exit 1; }
"$control" restart
wait_http
"$control" stop
if "$control" status; then echo "Foxwarm is still running after stop" >&2; exit 1; fi
echo "Upgrade smoke passed: $(basename "$old") -> $(basename "$new")"
