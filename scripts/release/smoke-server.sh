#!/usr/bin/env bash
# Install a Linux server package into a disposable directory, then exercise
# start, HTTP sign-in page, status, forced reinstall through update, and stop.
# Usage: scripts/release/smoke-server.sh PACKAGE [PORT]
set -euo pipefail

package="$(realpath "${1:?Usage: smoke-server.sh PACKAGE [PORT]}")"
port="${2:-3001}"
installer="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/install-foxwarm.sh"
work="$(mktemp -d)"
export FOXWARM_TMUX_SESSION="foxwarm-smoke-$$"
# Use a private tmux server, never the caller's.
unset TMUX
export TMUX_TMPDIR="$work"
control="$work/foxwarm/foxwarmctl"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && tmux has-session -t "=$FOXWARM_TMUX_SESSION" 2>/dev/null; then
    tmux capture-pane -p -S -200 -t "=$FOXWARM_TMUX_SESSION:=foxwarm" || true
  fi
  [ -x "$control" ] && "$control" stop >/dev/null 2>&1 || true
  tmux kill-server 2>/dev/null || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT

wait_http() {
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/login.html"; then return 0; fi
    sleep 0.5
  done
  echo "Foxwarm did not serve the sign-in page on port $port" >&2
  return 1
}

mkdir -p "$work/data/state"
printf 'bot:\n  httpPort: %s\n' "$port" > "$work/data/state/config.yaml"
(cd "$work" && bash "$installer" --package "$package" --dir foxwarm --data-dir data)
wait_http
[ -s "$work/data/state/token" ] || { echo "No sign-in token was created" >&2; exit 1; }
"$control" status
first="$(tmux display-message -p -t "=$FOXWARM_TMUX_SESSION:=foxwarm" '#{pane_pid}')"

"$control" update --package "$package" --force
wait_http
second="$(tmux display-message -p -t "=$FOXWARM_TMUX_SESSION:=foxwarm" '#{pane_pid}')"
[ "$first" != "$second" ] || { echo "Update did not restart Foxwarm" >&2; exit 1; }
[ "$(find "$work/foxwarm/runtime" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ] || { ls -la "$work/foxwarm/runtime" >&2; echo "Old releases were not removed" >&2; exit 1; }

"$control" stop
if "$control" status; then echo "Foxwarm is still running after stop" >&2; exit 1; fi
kill -0 "$second" 2>/dev/null && { echo "PID $second survived stop" >&2; exit 1; }
"$control" version
echo "Smoke test passed: $(basename "$package")"
