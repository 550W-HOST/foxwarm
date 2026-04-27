#!/bin/bash
# Start foxwarm in tmux session

SESSION="${FOXWARM_TMUX_SESSION:-foxwarm}"
WINDOW_NAME="foxwarm"
# Get foxwarm root directory (parent of scripts dir)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FOXWARM_DIR="$(dirname "$SCRIPT_DIR")"

# Build first
echo "Building foxwarm..."
cd "$FOXWARM_DIR"
npm run build-all || exit 1

START_CMD="cd $(printf '%q' "$FOXWARM_DIR") && "
if [ -n "${FOXWARM_DATA_DIR:-}" ]; then
    START_CMD+="FOXWARM_DATA_DIR=$(printf '%q' "$FOXWARM_DATA_DIR") "
fi
START_CMD+="node lib/index.js"

# Check if session exists
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session $SESSION already exists. Use restart.sh to restart."
    exit 1
fi

# Create new session
tmux new-session -d -s "$SESSION" -n "$WINDOW_NAME" -c "$FOXWARM_DIR"
echo "Created new tmux session: $SESSION"

# Start foxwarm
tmux send-keys -t "$SESSION:$WINDOW_NAME" "$START_CMD" Enter

echo "Foxwarm started in tmux session: $SESSION"
echo "Attach with: tmux attach -t $SESSION"
