#!/bin/bash
# Shared source stop path. Callers supply FOXWARM_DIR and the exact pane, if present.
PID_FILE="$FOXWARM_DIR/foxwarm.pid"

source_alive() {
    local state
    state=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
    [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

source_main_pid() {
    local args
    case "$1" in ''|*[!0-9]*|0|1) return 1 ;; esac
    source_alive "$1" || return 1
    args=$(ps -ww -o args= -p "$1" 2>/dev/null) || return 1
    # Main may have trailing source arguments; require an installation-root boundary.
    case "$args" in
        *"Foxwarm.dll --installation-root $FOXWARM_DIR"|\
        *"Foxwarm.dll --installation-root $FOXWARM_DIR "*|\
        *"Foxwarm --installation-root $FOXWARM_DIR"|\
        *"Foxwarm --installation-root $FOXWARM_DIR "*) return 0 ;;
    esac
    return 1
}

source_stop() {
    local pid="" shell_pid="" foreground="" candidate group deadline killed=""
    if [ -n "${PANE:-}" ]; then
        shell_pid=$(tmux display-message -p -t "$PANE" '#{pane_pid}') || return 1
        foreground=$(ps -o tpgid= -p "$shell_pid" | tr -d ' ')
    fi
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE")
        if ! source_main_pid "$pid"; then
            echo "Ignoring stale Main PID file."
            rm -f "$PID_FILE" || return 1
            pid=""
        fi
    elif [ -n "$foreground" ] && [ "$foreground" != "$shell_pid" ]; then
        # One-time adoption for a Main started before main.js wrote a PID file.
        # Search only the exact pane's foreground group and validate Main itself;
        # unrelated shell jobs and their process groups never receive a signal.
        while read -r candidate group; do
            if [ "$group" = "$foreground" ] && source_main_pid "$candidate"; then
                pid=$candidate
                break
            fi
        done < <(ps -axo pid=,pgid=)
    fi
    if [ -z "$pid" ]; then
        echo "Foxwarm is not running."
    else
        source_main_pid "$pid" && kill -TERM "$pid" 2>/dev/null
        deadline=$((SECONDS + 60))
        while source_main_pid "$pid"; do
            if [ "$SECONDS" -ge "$deadline" ]; then
                if [ -n "$killed" ]; then
                    echo "Error: Main has not exited after SIGKILL." >&2
                    return 1
                fi
                echo "Main did not stop within 60 seconds; sending SIGKILL." >&2
                source_main_pid "$pid" && kill -KILL "$pid" 2>/dev/null
                killed=1
                deadline=$((SECONDS + 10))
            fi
            sleep 0.2
        done
        rm -f "$PID_FILE" || return 1
    fi
    # main.js awaits its child and exits on both ordinary stop and forced kill.
    # Do not report completion or type startup until its shell has the terminal.
    if [ -n "$shell_pid" ]; then
        deadline=$((SECONDS + 10))
        while [ "$(ps -o tpgid= -p "$shell_pid" | tr -d ' ')" != "$shell_pid" ]; do
            if [ "$SECONDS" -ge "$deadline" ]; then
                echo "Error: The source pane is still busy; no startup was sent." >&2
                return 1
            fi
            sleep 0.2
        done
    fi
    [ -z "$pid" ] || echo "Foxwarm stopped."
}
