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

# Capture an explicit installation root before changing the caller's directory.
if [ -n "${FOXWARM_APP_ROOT:-}" ]; then
    FOXWARM_APP_ROOT="$("$NODE_BIN" -e 'process.stdout.write(require(process.argv[1]).coreEnvironment().FOXWARM_APP_ROOT)' "$SCRIPT_DIR/core-executable.js")" || exit 1
fi

# Build first
echo "Building foxwarm..."
cd "$FOXWARM_DIR"
npm run build-all || exit 1

UNSET_ENV=""
SET_ENV=""
START_CMD="cd $(printf '%q' "$FOXWARM_DIR") && env "
# A long-lived tmux server may have a different environment from this invocation.
for name in FOXWARM_APP_ROOT FOXWARM_DATA_DIR FOXWARM_CONFIG_PATH CONFIG_PATH MCP_CONFIG_PATH FOXWARM_HTTP_PORT FOXWARM_BIND_ADDRESS DOTNET_ROOT; do
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
# Wait for the foreground job to return the terminal to its shell; draining Main
# must finish before another startup command is entered into that terminal.
tmux send-keys -t "$PANE" C-c || exit 1
SHELL_PID=$(tmux display-message -p -t "$PANE" '#{pane_pid}') || exit 1
DEADLINE=$((SECONDS + 60))
while [ "$(ps -o tpgid= -p "$SHELL_PID" | tr -d ' ')" != "$SHELL_PID" ]; do
    if [ "$SECONDS" -ge "$DEADLINE" ]; then
        echo "Error: Main has not returned the terminal after shutdown; no restart was sent." >&2
        exit 1
    fi
    sleep 0.2
done
tmux send-keys -t "$PANE" -l "$START_CMD" || exit 1
tmux send-keys -t "$PANE" Enter || exit 1

echo "Restart command sent to $FOXWARM_DIR"
