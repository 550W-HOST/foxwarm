#!/bin/bash
# Stop foxwarm

SESSION="foxwarm"
WINDOW_NAME="foxwarm"

# Check if session exists
if ! tmux has-session -t $SESSION 2>/dev/null; then
    echo "Session $SESSION does not exist."
    exit 1
fi

# Send Ctrl+C to stop the process
tmux send-keys -t $SESSION:$WINDOW_NAME C-c

echo "Stop signal sent to foxwarm"
echo "To kill the session completely: tmux kill-session -t $SESSION"
