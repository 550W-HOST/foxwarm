#!/bin/bash
# Stop source Main and wait for its foreground launcher to exit.

SESSION="${FOXWARM_TMUX_SESSION:-foxwarm}"
WINDOW_NAME="foxwarm"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"
FOXWARM_DIR="$(dirname "$SCRIPT_DIR")"

# A PID file can identify Main even when there is no longer a tmux pane.
PANE=$(tmux list-panes -t "=$SESSION:=$WINDOW_NAME" -F '#{?pane_active,#{pane_id},}' 2>/dev/null | grep -v '^$')
source "$SCRIPT_DIR/source-process.sh"
source_stop
