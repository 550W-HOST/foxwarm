#!/bin/bash
# Start foxwarm in tmux session

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
for name in FOXWARM_APP_ROOT FOXWARM_DATA_DIR FOXWARM_CONFIG_PATH CONFIG_PATH MCP_CONFIG_PATH DOTNET_ROOT; do
    if [ -n "${!name:-}" ]; then
        SET_ENV+="$(printf '%q' "$name=${!name}") "
    else
        UNSET_ENV+="-u $name "
    fi
done
START_CMD+="$UNSET_ENV$SET_ENV$(printf '%q' "PATH=$PATH") $(printf '%q' "$NODE_BIN") scripts/main.js"
for arg in "$@"; do START_CMD+=" $(printf '%q' "$arg")"; done

# Check if session exists
if tmux has-session -t "=$SESSION" 2>/dev/null; then
    echo "Session $SESSION already exists. Use restart.sh to restart."
    exit 1
fi

# Create new session
PANE=$(tmux new-session -d -s "$SESSION" -n "$WINDOW_NAME" -c "$FOXWARM_DIR" -P -F '#{pane_id}') || exit 1
echo "Created new tmux session: $SESSION"

# Start foxwarm
tmux send-keys -t "$PANE" -l "$START_CMD" || exit 1
tmux send-keys -t "$PANE" Enter || exit 1

echo "Foxwarm started in tmux session: $SESSION"
echo "Attach with: tmux attach -t $SESSION"
