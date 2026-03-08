#!/bin/bash
# Restart foxwarm - creates session if needed, uses dedicated window

SESSION="foxwarm"
WINDOW_NAME="foxwarm"
# Get foxwarm root directory (parent of scripts dir)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FOXWARM_DIR="$(dirname "$SCRIPT_DIR")"

# Build first
echo "Building foxwarm..."
cd "$FOXWARM_DIR"
npm run build-all || exit 1

# Check if session exists
if ! tmux has-session -t $SESSION 2>/dev/null; then
    # Try to create new session
    if ! tmux new-session -d -s $SESSION -n $WINDOW_NAME -c "$FOXWARM_DIR" 2>/dev/null; then
        echo "Error: Failed to create tmux session. Are you inside a tmux session?"
        echo "If you're in tmux, you can create the session from outside tmux first."
        exit 1
    fi
    echo "Created new tmux session: $SESSION"
fi

# Check if the window exists
if ! tmux list-windows -t $SESSION 2>/dev/null | grep -q "$WINDOW_NAME"; then
    tmux new-window -t $SESSION -n $WINDOW_NAME -c "$FOXWARM_DIR"
fi

# Send Ctrl+C and restart command.
# NOTICE: this script might be exec-ed by the bot. After C-c, this script will be killed too, but tmux keeps running.
# NOTICE: So `C-c` in the same line with `node lib/index.js` ensuring the bot will be killed and restart by the bash in tmux.
tmux send-keys -t $SESSION:$WINDOW_NAME C-c "cd $FOXWARM_DIR && node lib/index.js" Enter

echo "Restart command sent to $FOXWARM_DIR"
