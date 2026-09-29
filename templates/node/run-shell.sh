#!/bin/sh
# A transient POSIX-shell exec Node. No package installation or complete logs.
set -u
umask 077
LC_ALL=C
export LC_ALL
HOST='__FOXWARM_DEFAULT_BASE_URL__'
NODE_ID=${NODE_ID:-}
AUTH_TOKEN=${NODE_AUTH_TOKEN:-}
for arg in "$@"; do
  case "$arg" in
    --host=*) HOST=${arg#*=} ;;
    --node-id=*) NODE_ID=${arg#*=} ;;
    --auth-token=*) AUTH_TOKEN=${arg#*=} ;;
    --help|-h)
      printf '%s\n' 'Usage: sh run-shell.sh --host=URL --node-id=ID --auth-token=TOKEN' \
        'Uses sh, curl, mktemp, mkfifo, dd, wc, head, tail, cat, mv, rm, mkdir, chmod, sleep, date, sed and tr.' \
        'The token can also be supplied in NODE_AUTH_TOKEN. No programs are installed.' \
        'Run from the desired default working directory. Output retains only 4 KiB head/tail.'
      exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done
for app in sh curl mktemp mkfifo dd wc head tail cat mv rm mkdir chmod sleep date sed tr; do
  command -v "$app" >/dev/null 2>&1 || { printf 'Missing required program: %s\n' "$app" >&2; exit 1; }
done
case "$HOST" in http://*|https://*) ;; *) echo 'An HTTP(S) --host URL is required.' >&2; exit 1 ;; esac
case "$HOST" in *'?'*|*'#'*|*'@'*) echo 'Host URL must not contain credentials, query or fragment.' >&2; exit 1 ;; esac
case "$NODE_ID" in ''|*[!a-zA-Z0-9_-]*) echo 'A valid --node-id from /node create is required.' >&2; exit 1 ;; esac
case "$AUTH_TOKEN" in *[!a-fA-F0-9]*|'') echo 'A per-node token from /node create is required.' >&2; exit 1 ;; esac
[ "${#AUTH_TOKEN}" -eq 64 ] || { echo 'Per-node token must have 64 hexadecimal characters.' >&2; exit 1; }
HOST=${HOST%/}
START_CWD=$(pwd -P)
STATE=$(mktemp -d "${TMPDIR:-/tmp}/foxwarm-shell.XXXXXX") || exit 1
printf 'header = "Authorization: Bearer %s"\nheader = "X-Foxwarm-Node: %s"\n' "$AUTH_TOKEN" "$NODE_ID" > "$STATE/auth"
chmod 600 "$STATE/auth"
unset AUTH_TOKEN NODE_AUTH_TOKEN
printf '%s' "$START_CWD" > "$STATE/cwd"
# Do not remove active FIFO/collector files on exit: running commands are not killed.
STOP=0
trap 'STOP=1' INT TERM
header_value() {
  tr '[:upper:]' '[:lower:]' < "$1" | tr -d '\r' | sed -n "s/^$2: *//p"
}
# All calls keep secrets in a private curl config, never the URL or curl argv.
http() {
  headers=$1; response=$2; endpoint=$3; shift 3
  curl --silent --config "$STATE/auth" --connect-timeout 10 --max-time 35 \
    --max-filesize 65536 --dump-header "$headers" --output "$response" --write-out '%{http_code}' \
    "$@" "$HOST/node/shell/$endpoint"
}
code=$(http "$STATE/register.headers" "$STATE/register.body" register \
  -H 'Content-Type: application/octet-stream' --data-binary "@$STATE/cwd") || code=000
CONNECTION=$(header_value "$STATE/register.headers" 'x-foxwarm-connection')
case "$CONNECTION" in ''|*[!a-f0-9]*) CONNECTION=invalid ;; esac
if [ "$code" != 204 ] || [ "${#CONNECTION}" -ne 32 ] || \
   [ "$(header_value "$STATE/register.headers" 'x-foxwarm-shell')" != foxwarm-shell-1 ]; then
  echo 'Shell Node registration failed; no command was executed.' >&2
  rm -rf "$STATE"; exit 1
fi
printf 'Shell Node %s ready (POSIX sh, bounded output).\n' "$NODE_ID"

collect() {
  dir=$1
  : > "$dir/head"; : > "$dir/tail"
  total=0
  exec 3< "$dir/pipe"
  while :; do
    dd bs=4096 count=1 <&3 > "$dir/chunk" 2>/dev/null
    size=$(wc -c < "$dir/chunk")
    [ "$size" -gt 0 ] || break
    if [ "$total" -lt 4096 ]; then
      head -c "$((4096 - total))" "$dir/chunk" >> "$dir/head"
    fi
    cat "$dir/tail" "$dir/chunk" > "$dir/combined"
    tail -c 4096 "$dir/combined" > "$dir/next-tail"
    mv "$dir/next-tail" "$dir/tail"
    total=$((total + size))
  done
  exec 3<&-
  if [ "$total" -le 4096 ]; then
    cat "$dir/head" > "$dir/output"
  elif [ "$total" -le 8192 ]; then
    cat "$dir/head" > "$dir/output"
    tail -c "$((total - 4096))" "$dir/tail" >> "$dir/output"
  else
    cat "$dir/head" "$dir/tail" > "$dir/output"
  fi
  printf '%s\n' "$total" > "$dir/bytes"
}

report() {
  dir=$1; kind=$2
  while :; do
    # The existing completion authorization expires after 24 hours from dispatch.
    now=$(date +%s)
    [ "$((now - $(cat "$dir/started")))" -le 86400 ] || return 1
    if [ "$kind" = finished ]; then
      code=$(http "$dir/report.headers" "$dir/report.body" report \
        -H "X-Foxwarm-Connection: $CONNECTION" -H "X-Foxwarm-Task: $(cat "$dir/id")" \
        -H 'X-Foxwarm-Result: finished' -H "X-Foxwarm-Bytes: $(cat "$dir/bytes")" \
        -H "X-Foxwarm-Exit: $(cat "$dir/exit")" -H 'Content-Type: application/octet-stream' \
        --data-binary "@$dir/output") || code=000
    else
      code=$(http "$dir/background.headers" "$dir/background.body" report \
        -H "X-Foxwarm-Connection: $CONNECTION" -H "X-Foxwarm-Task: $(cat "$dir/id")" \
        -H 'X-Foxwarm-Result: background' -H 'Content-Type: application/octet-stream' \
        --data-binary '') || code=000
    fi
    headers="$dir/report.headers"
    [ "$kind" = finished ] || headers="$dir/background.headers"
    if [ "$code" = 204 ] && [ "$(header_value "$headers" 'x-foxwarm-shell')" = foxwarm-shell-1 ]; then return 0; fi
    case "$code" in 400|401|403|409|410|413|415) return 1 ;; esac
    sleep 2
  done
}

run_job() {
  dir=$1
  # A collector drains all bytes; sample truncation never closes the command's pipe.
  collect "$dir" & collector=$!
  sh "$dir/script" > "$dir/pipe" 2>&1
  rc=$?
  wait "$collector"
  printf '%s\n' "$rc" > "$dir/exit"
  : > "$dir/ready"
  while [ ! -f "$dir/decision" ]; do sleep 1; done
  if [ "$(cat "$dir/decision")" = foreground ]; then
    report "$dir" finished || echo 'Foreground result unavailable; command will not be executed again.' >&2
  else
    report "$dir" finished || echo 'Background completion unavailable; command will not be executed again.' >&2
  fi
  rm -rf "$dir"
  if [ -f "$STATE/stopped" ]; then
    active=0
    for remaining in "$STATE"/task-*; do [ ! -d "$remaining" ] || active=$((active + 1)); done
    [ "$active" -gt 0 ] || rm -rf "$STATE"
  fi
}

while [ "$STOP" -eq 0 ]; do
  # Bound transient local jobs as well as each job's output files.
  active=0
  for dir in "$STATE"/task-*; do [ ! -d "$dir" ] || active=$((active + 1)); done
  if [ "$active" -ge 4 ]; then sleep 1; continue; fi
  code=$(http "$STATE/poll.headers" "$STATE/poll.body" poll -H "X-Foxwarm-Connection: $CONNECTION") || code=000
  protocol=$(header_value "$STATE/poll.headers" 'x-foxwarm-shell')
  if [ "$code" = 204 ] && [ "$protocol" = foxwarm-shell-1 ]; then continue; fi
  case "$code" in 401|403|409|410) echo 'Shell Node disconnected; existing commands are not re-executed.' >&2; break ;; esac
  if [ "$code" != 200 ] || [ "$protocol" != foxwarm-shell-1 ] || \
     [ "$(header_value "$STATE/poll.headers" 'content-type')" != 'application/x-foxwarm-shell; charset=utf-8' ]; then
    sleep 2; continue
  fi
  task=$(header_value "$STATE/poll.headers" 'x-foxwarm-task')
  exec_id=$(header_value "$STATE/poll.headers" 'x-foxwarm-exec')
  timeout=$(header_value "$STATE/poll.headers" 'x-foxwarm-timeout')
  case "$task" in ''|*[!a-f0-9]*) sleep 2; continue ;; esac
  case "$exec_id" in ''|*[!a-z0-9_-]*) sleep 2; continue ;; esac
  case "$timeout" in ''|*[!0-9]*) sleep 2; continue ;; esac
  if [ "${#task}" -ne 32 ] || [ "$timeout" -lt 1 ] || [ "$timeout" -gt 60 ]; then sleep 2; continue; fi
  dir="$STATE/task-$task"
  # A duplicate task cannot cause a second command start within this process.
  if [ -d "$dir" ]; then echo 'Duplicate task ignored.' >&2; continue; fi
  mkdir "$dir" || continue
  mv "$STATE/poll.body" "$dir/script"
  printf '%s\n' "$task" > "$dir/id"
  date +%s > "$dir/started"
  mkfifo "$dir/pipe" || { rm -rf "$dir"; continue; }
  run_job "$dir" &
  elapsed=0
  while [ ! -f "$dir/ready" ] && [ "$elapsed" -lt "$timeout" ]; do sleep 1; elapsed=$((elapsed + 1)); done
  if [ -f "$dir/ready" ]; then
    printf 'foreground\n' > "$dir/decision"
  else
    # Only retry this notice, never the command that has already started.
    report "$dir" background
    printf 'background\n' > "$dir/decision"
  fi
done
# A completed reporter removes its job state. Leave the private shared auth file
# available to still-running wrappers; do not kill processes or unlink their FIFO.
: > "$STATE/stopped"
active=0
for dir in "$STATE"/task-*; do [ ! -d "$dir" ] || active=$((active + 1)); done
[ "$active" -gt 0 ] || rm -rf "$STATE"
