#!/bin/bash
# Restart foxwarm - creates session if needed, uses dedicated window

SESSION="${FOXWARM_TMUX_SESSION:-foxwarm}"
WINDOW_NAME="foxwarm"
# Get foxwarm root directory (parent of scripts dir)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FOXWARM_DIR="$(dirname "$SCRIPT_DIR")"

NODE_BIN="${FOXWARM_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
    echo "Error: node not found. Set FOXWARM_NODE_BIN=/path/to/node"
    exit 1
fi

# Build first
echo "Building foxwarm..."
cd "$FOXWARM_DIR"
npm run build-all -- --stage-only || exit 1

UNSET_ENV=""
SET_ENV=""
START_CMD="cd $(printf '%q' "$FOXWARM_DIR") && env "
# A long-lived tmux server may have a different environment from this invocation.
for name in FOXWARM_DATA_DIR MCP_CONFIG_PATH DOTNET_ROOT; do
    if [ -n "${!name:-}" ]; then
        SET_ENV+="$(printf '%q' "$name=${!name}") "
    else
        UNSET_ENV+="-u $name "
    fi
done
START_CMD+="$UNSET_ENV$SET_ENV$(printf '%q' "PATH=$PATH") $(printf '%q' "$NODE_BIN") scripts/main.js"
for arg in "$@"; do START_CMD+=" $(printf '%q' "$arg")"; done

# Check if session exists
if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
    # Try to create new session
    if ! PANE=$(tmux new-session -d -s "$SESSION" -n "$WINDOW_NAME" -c "$FOXWARM_DIR" -P -F '#{pane_id}' 2>/dev/null); then
        echo "Error: Failed to create tmux session. Are you inside a tmux session?"
        echo "If you're in tmux, you can create the session from outside tmux first."
        exit 1
    fi
    echo "Created new tmux session: $SESSION"
else
    # list-panes fails for a missing exact window; display-message may fall back
    # to another window. Select only the active pane in the dedicated window.
    if ! PANE=$(tmux list-panes -t "=$SESSION:=$WINDOW_NAME" -F '#{?pane_active,#{pane_id},}' 2>/dev/null | grep -v '^$'); then
        PANE=$(tmux new-window -t "=$SESSION:" -n "$WINDOW_NAME" -c "$FOXWARM_DIR" -P -F '#{pane_id}') || exit 1
    fi
fi

# Keep the same pane even if tmux renames its window after the process exits.
# A pane in copy or another mode would consume Ctrl+C instead of passing it on.
if [ "$(tmux display-message -p -t "$PANE" '#{pane_in_mode}')" = 1 ]; then
    tmux send-keys -t "$PANE" -X cancel || exit 1
fi
SHELL_PID=$(tmux display-message -p -t "$PANE" '#{pane_pid}') || exit 1
FOREGROUND=$(ps -o tpgid= -p "$SHELL_PID" | tr -d ' ')
# Main has stopped once its whole foreground process group is gone and the
# terminal is back with the shell. A drain that exceeds the deadline is killed.
main_running() {
    [ "$(ps -o tpgid= -p "$SHELL_PID" | tr -d ' ')" != "$SHELL_PID" ] && return 0
    [ -n "$FOREGROUND" ] && [ "$FOREGROUND" -gt 1 ] && [ "$FOREGROUND" != "$SHELL_PID" ] \
        && kill -0 -- "-$FOREGROUND" 2>/dev/null
}
tmux send-keys -t "$PANE" C-c || exit 1
DEADLINE=$((SECONDS + 60))
KILLED=
while main_running; do
    if [ "$SECONDS" -ge "$DEADLINE" ]; then
        if [ -n "$KILLED" ]; then
            echo "Error: Main has not exited after SIGKILL; no restart was sent." >&2
            exit 1
        fi
        echo "Main did not stop within 60 seconds; sending SIGKILL." >&2
        for group in "$FOREGROUND" "$(ps -o tpgid= -p "$SHELL_PID" | tr -d ' ')"; do
            if [ -n "$group" ] && [ "$group" -gt 1 ] && [ "$group" != "$SHELL_PID" ]; then
                kill -KILL -- "-$group" 2>/dev/null
            fi
        done
        KILLED=1
        DEADLINE=$((SECONDS + 10))
    fi
    sleep 0.2
done
"$NODE_BIN" scripts/build-source.js --promote || exit 1
tmux send-keys -t "$PANE" -l "$START_CMD" || exit 1
tmux send-keys -t "$PANE" Enter || exit 1

echo "Restart command sent to $FOXWARM_DIR"
