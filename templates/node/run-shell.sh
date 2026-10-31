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
# Timestamped events for the person running this Node. Never print credentials.
log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}
# Bounded display text: first $2 lines and $3 bytes of file $1, without terminal controls.
excerpt() {
  head -n "$2" "$1" | head -c "$3" | tr -d '\000-\010\013-\037\177'
}
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
valid_connection() {
  case "$1" in ''|*[!a-f0-9]*) return 1 ;; esac
  [ "${#1}" -eq 32 ]
}
terminal_message() {
  case "$1" in
    401|403) log 'Stopped: credentials rejected or revoked.' ;;
    409)
      if [ "${2:-}" = connection-replaced ]; then
        log 'Stopped: connection replaced by another client.'
      else
        log 'Stopped: connection conflict with Main.'
      fi ;;
    410) log 'Stopped: connection retired by Main.' ;;
    *) log 'Stopped: registration rejected by Main.' ;;
  esac
}
# HEAD only reads the predecessor and proposes an identity. A lost response has no effect.
# POST retries use the same pair, so an unobserved success cannot replace a successor.
CONNECTION=
PREDECESSOR=
LEGACY=0
retry_notice=0
while [ "$STOP" -eq 0 ]; do
  code=$(http "$STATE/register.headers" "$STATE/register.body" register --head) || code=000
  if [ "$code" = 204 ] && [ "$(header_value "$STATE/register.headers" 'x-foxwarm-shell')" = foxwarm-shell-1 ]; then
    CONNECTION=$(header_value "$STATE/register.headers" 'x-foxwarm-connection')
    PREDECESSOR=$(header_value "$STATE/register.headers" 'x-foxwarm-predecessor')
    if valid_connection "$CONNECTION" && { [ "$PREDECESSOR" = none ] || valid_connection "$PREDECESSOR"; }; then break; fi
  fi
  case "$code" in
    404|405|501) LEGACY=1; break ;;
    400|401|403|409|410|413|415) terminal_message "$code"; rm -rf "$STATE"; exit 1 ;;
  esac
  if [ "$retry_notice" -eq 0 ]; then log 'Main unavailable; retrying registration every 2 seconds.'; retry_notice=1; fi
  sleep 2
done
register() {
  retry_notice=0
  while [ "$STOP" -eq 0 ]; do
    if [ "$LEGACY" -eq 1 ]; then
      code=$(http "$STATE/register.headers" "$STATE/register.body" register \
        -H 'Content-Type: application/octet-stream' --data-binary "@$STATE/cwd") || code=000
    else
      code=$(http "$STATE/register.headers" "$STATE/register.body" register \
        -H "X-Foxwarm-Connection: $CONNECTION" -H "X-Foxwarm-Predecessor: $PREDECESSOR" \
        -H 'Content-Type: application/octet-stream' --data-binary "@$STATE/cwd") || code=000
    fi
    registered=$(header_value "$STATE/register.headers" 'x-foxwarm-connection')
    if [ "$code" = 204 ] && valid_connection "$registered" && \
       [ "$(header_value "$STATE/register.headers" 'x-foxwarm-shell')" = foxwarm-shell-1 ] && \
       { [ "$LEGACY" -eq 1 ] || [ "$registered" = "$CONNECTION" ]; }; then
      CONNECTION=$registered; PREDECESSOR=$CONNECTION
      return 0
    fi
    case "$code" in 400|401|403|409|410|413|415) terminal_message "$code" "$(header_value "$STATE/register.headers" 'x-foxwarm-shell-reason')"; return 1 ;; esac
    if [ "$LEGACY" -eq 1 ]; then
      log 'Stopped: registration not confirmed, and this Main version cannot retry it safely.'; return 1
    fi
    if [ "$retry_notice" -eq 0 ]; then log 'Main unavailable; retrying registration every 2 seconds.'; retry_notice=1; fi
    sleep 2
  done
  return 1
}
if ! register; then rm -rf "$STATE"; exit 1; fi
log "Shell Node $NODE_ID connected (POSIX sh)."
retry_notice=0

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
  # Capture once; report retries must not increase the command's duration.
  if [ "$kind" = finished ]; then
    process_elapsed=$(cat "$dir/duration")
  else
    process_elapsed=$(( $(date +%s) - $(cat "$dir/process-started") ))
  fi
  while :; do
    # The existing completion authorization expires after 24 hours from dispatch.
    now=$(date +%s)
    [ "$((now - $(cat "$dir/started")))" -le 86400 ] || return 1
    if [ "$kind" = finished ]; then
      code=$(http "$dir/report.headers" "$dir/report.body" report \
        -H "X-Foxwarm-Connection: $CONNECTION" -H "X-Foxwarm-Task: $(cat "$dir/id")" \
        -H 'X-Foxwarm-Result: finished' -H "X-Foxwarm-Bytes: $(cat "$dir/bytes")" \
        -H "X-Foxwarm-Elapsed-Seconds: $process_elapsed" \
        -H "X-Foxwarm-Exit: $(cat "$dir/exit")" -H 'Content-Type: application/octet-stream' \
        --data-binary "@$dir/output") || code=000
    else
      code=$(http "$dir/background.headers" "$dir/background.body" report \
        -H "X-Foxwarm-Connection: $CONNECTION" -H "X-Foxwarm-Task: $(cat "$dir/id")" \
        -H 'X-Foxwarm-Result: background' -H "X-Foxwarm-Elapsed-Seconds: $process_elapsed" -H 'Content-Type: application/octet-stream' \
        --data-binary '') || code=000
    fi
    headers="$dir/report.headers"
    [ "$kind" = finished ] || headers="$dir/background.headers"
    if [ "$code" = 204 ] && [ "$(header_value "$headers" 'x-foxwarm-shell')" = foxwarm-shell-1 ]; then return 0; fi
    case "$code" in 400|401|403|409|410|413|415) return 1 ;; esac
    sleep 2
  done
}

# Show what Main asked this Node to run. Main prefixes the command with its cd line.
started() {
  dir=$1
  sed -n '2,$p' "$dir/script" > "$dir/command"
  where=$(sed -n "1s/^cd '\(.*\)' || exit 125\$/\\1/p" "$dir/script" | sed "s/'\"'\"'/'/g")
  text=$(excerpt "$dir/command" 1 160)
  [ "$(wc -c < "$dir/command")" -le "$(( ${#text} + 1 ))" ] || text="$text …"
  if [ -n "$where" ] && [ "$where" != "$START_CWD" ]; then
    log "exec $(cat "$dir/exec") in $where: $text"
  else
    log "exec $(cat "$dir/exec"): $text"
  fi
}

# Summarize the result, with the beginning of its output.
finished() {
  dir=$1
  total=$(cat "$dir/bytes")
  summary="exec $(cat "$dir/exec") finished: exit $(cat "$dir/exit"), $(cat "$dir/duration")s, $total bytes"
  shown=$(head -n 10 "$dir/output" | head -c 800 | wc -c)
  text=$(excerpt "$dir/output" 10 800)
  if [ -n "$text" ]; then
    summary="$summary
$(printf '%s\n' "$text" | sed 's/^/    /')"
  fi
  [ "$total" -le "$shown" ] || summary="$summary
    … $((total - shown)) more bytes"
  log "$summary"
}

run_job() {
  dir=$1; timeout=$2
  # Each job owns its command, foreground budget and report retries independently.
  # The collector drains all bytes; truncation never closes the command's pipe.
  (
    collect "$dir" & collector=$!
    date +%s > "$dir/process-started"
    sh "$dir/script" > "$dir/pipe" 2>&1
    rc=$?
    printf '%s\n' "$(( $(date +%s) - $(cat "$dir/process-started") ))" > "$dir/duration"
    wait "$collector"
    printf '%s\n' "$rc" > "$dir/exit"
    : > "$dir/ready"
  ) & runner=$!
  elapsed=0
  while [ ! -f "$dir/ready" ] && [ "$elapsed" -lt "$timeout" ]; do sleep 1; elapsed=$((elapsed + 1)); done
  if [ ! -f "$dir/ready" ]; then
    # Only retry this notice, never the command that has already started.
    log "exec $(cat "$dir/exec") still running after ${timeout}s; continuing in background."
    report "$dir" background || log "exec $(cat "$dir/exec"): could not notify Main of background execution."
  fi
  wait "$runner"
  finished "$dir"
  report "$dir" finished || log "exec $(cat "$dir/exec"): could not deliver the result to Main."
  rm -rf "$dir"
  if [ -f "$STATE/stopped" ]; then
    active=0
    for remaining in "$STATE"/task-*; do [ ! -d "$remaining" ] || active=$((active + 1)); done
    [ "$active" -gt 0 ] || rm -rf "$STATE"
  fi
}

while [ "$STOP" -eq 0 ]; do
  # Main bounds unfinished dispatches. Waiting/reports must never block polling.
  code=$(http "$STATE/poll.headers" "$STATE/poll.body" poll -H "X-Foxwarm-Connection: $CONNECTION") || code=000
  protocol=$(header_value "$STATE/poll.headers" 'x-foxwarm-shell')
  if [ "$code" = 204 ] && [ "$protocol" = foxwarm-shell-1 ]; then
    if [ "$retry_notice" -eq 1 ]; then log 'Connection to Main restored.'; retry_notice=0; fi
    continue
  fi
  reason=$(header_value "$STATE/poll.headers" 'x-foxwarm-shell-reason')
  if [ "$code" = 409 ] && [ "$protocol" = foxwarm-shell-1 ] && [ "$LEGACY" -eq 0 ]; then
    case "$reason" in
      connection-unavailable)
        [ "$STOP" -eq 0 ] || break
        log 'Disconnected: Main restarted or the connection expired; reconnecting.'
        if ! register; then break; fi
        log 'Reconnected to Main.'
        retry_notice=0; continue ;;
      poll-pending)
        if [ "$retry_notice" -eq 0 ]; then log 'Previous poll is still open on Main; retrying every 2 seconds.'; retry_notice=1; fi
        sleep 2; continue ;;
    esac
  fi
  case "$code" in 401|403|409|410) terminal_message "$code" "$reason"; break ;; esac
  if [ "$code" != 200 ] || [ "$protocol" != foxwarm-shell-1 ] || \
     [ "$(header_value "$STATE/poll.headers" 'content-type')" != 'application/x-foxwarm-shell; charset=utf-8' ]; then
    if [ "$retry_notice" -eq 0 ]; then log 'Lost connection to Main; retrying every 2 seconds.'; retry_notice=1; fi
    sleep 2; continue
  fi
  if [ "$retry_notice" -eq 1 ]; then log 'Connection to Main restored.'; retry_notice=0; fi
  task=$(header_value "$STATE/poll.headers" 'x-foxwarm-task')
  exec_id=$(header_value "$STATE/poll.headers" 'x-foxwarm-exec')
  timeout=$(header_value "$STATE/poll.headers" 'x-foxwarm-timeout')
  case "$task" in ''|*[!a-f0-9]*) sleep 2; continue ;; esac
  case "$exec_id" in ''|*[!a-z0-9_-]*) sleep 2; continue ;; esac
  case "$timeout" in ''|*[!0-9]*) sleep 2; continue ;; esac
  if [ "${#task}" -ne 32 ] || [ "$timeout" -lt 1 ] || [ "$timeout" -gt 60 ]; then sleep 2; continue; fi
  dir="$STATE/task-$task"
  # A duplicate task cannot cause a second command start within this process.
  if [ -d "$dir" ]; then log 'Duplicate task ignored.'; continue; fi
  mkdir "$dir" || continue
  mv "$STATE/poll.body" "$dir/script"
  printf '%s\n' "$task" > "$dir/id"
  printf '%s\n' "$exec_id" > "$dir/exec"
  started "$dir"
  date +%s > "$dir/started"
  mkfifo "$dir/pipe" || { rm -rf "$dir"; continue; }
  run_job "$dir" "$timeout" &
done
# A completed reporter removes its job state. Leave the private shared auth file
# available to still-running wrappers; do not kill processes or unlink their FIFO.
: > "$STATE/stopped"
active=0
for dir in "$STATE"/task-*; do [ ! -d "$dir" ] || active=$((active + 1)); done
[ "$active" -gt 0 ] || rm -rf "$STATE"
