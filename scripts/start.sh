#!/bin/bash
# Start foxwarm in tmux session

SESSION="foxwarm"
WINDOW_NAME="foxwarm"
# Get foxwarm root directory (parent of scripts dir)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FOXWARM_DIR="$(dirname "$SCRIPT_DIR")"

# Build first
echo "Building foxwarm..."
cd "$FOXWARM_DIR"
npm run build || exit 1

# Check if session exists
if tmux has-session -t $SESSION 2>/dev/null; then
    echo "Session $SESSION already exists. Use restart.sh to restart."
    exit 1
fi

# Create new session
tmux new-session -d -s $SESSION -n $WINDOW_NAME -c "$FOXWARM_DIR"
echo "Created new tmux session: $SESSION"

# Start foxwarm
tmux send-keys -t $SESSION:$WINDOW_NAME "node lib/index.js" Enter

echo "Foxwarm started in tmux session: $SESSION"
echo "Attach with: tmux attach -t $SESSION"
