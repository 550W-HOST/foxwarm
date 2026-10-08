#!/bin/bash
# Restart foxwarm - creates session if needed, uses dedicated window

SESSION="${FOXWARM_TMUX_SESSION:-foxwarm}"
WINDOW_NAME="foxwarm"
# Get foxwarm root directory (parent of scripts dir)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FOXWARM_DIR="$(dirname "$SCRIPT_DIR")"

# Build first
echo "Building foxwarm..."
cd "$FOXWARM_DIR"
npm run build-all || exit 1

NODE_BIN="${FOXWARM_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
    echo "Error: node not found. Set FOXWARM_NODE_BIN=/path/to/node"
    exit 1
fi

START_CMD="cd $(printf '%q' "$FOXWARM_DIR") && "
if [ -n "${FOXWARM_DATA_DIR:-}" ]; then
    START_CMD+="FOXWARM_DATA_DIR=$(printf '%q' "$FOXWARM_DATA_DIR") "
fi
START_CMD+="$(printf '%q' "$NODE_BIN") lib/index.js"

# Check if session exists
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    # Try to create new session
    if ! tmux new-session -d -s "$SESSION" -n "$WINDOW_NAME" -c "$FOXWARM_DIR" 2>/dev/null; then
        echo "Error: Failed to create tmux session. Are you inside a tmux session?"
        echo "If you're in tmux, you can create the session from outside tmux first."
        exit 1
    fi
    echo "Created new tmux session: $SESSION"
fi

# Check if the window exists
if ! tmux list-windows -t "$SESSION" 2>/dev/null | grep -q "$WINDOW_NAME"; then
    tmux new-window -t "$SESSION" -n "$WINDOW_NAME" -c "$FOXWARM_DIR"
fi

# Keep the same pane even if tmux renames its window after the process exits.
PANE=$(tmux display-message -p -t "$SESSION:$WINDOW_NAME" '#{pane_id}') || exit 1

# Give the terminal time to handle Ctrl+C before entering the restart command.
tmux send-keys -t "$PANE" C-c || exit 1
sleep 1
tmux send-keys -t "$PANE" -l "$START_CMD" || exit 1
tmux send-keys -t "$PANE" Enter || exit 1

echo "Restart command sent to $FOXWARM_DIR"
