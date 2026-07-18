#!/bin/sh

set -eu
umask 077

HOST="__FOXWARM_DEFAULT_BASE_URL__"
PAIRING=""
NODE_ID="node-$(hostname 2>/dev/null || echo foxwarm-node)"
INSTALL_DIR=""
PREPARE_ONLY=0
DETACH=0
INSTALL_SERVICE=0

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL http(s)://master/node/run.sh | bash -s -- \
    --dir=/opt/foxwarm-node \
    --pairing=PAIRING_TOKEN \
    --node-id=my-node

This is the bare-metal bootstrap path. It prepares a node client under the
explicitly selected --dir and runs it in the foreground by default.

The script defaults --host from the URL used to fetch /node/run.sh.
Pass --host only when the node should connect to a different reachable master URL.

Options:
  --dir=DIR           Required installation root. Source, data, env, logs, PID,
                      launcher, and generated service files stay under this dir
  --host=URL          Override Foxwarm master base URL (default: request-derived)
  --pairing=TOKEN     Pairing token for first setup; optional with stored credentials
  --node-id=ID        Requested node name (default: node-<hostname>)
  -d, --detach        Start in background; prefer tmux, otherwise use nohup
  --install           Install, enable, and start a systemd service. Root installs a
                      system service; non-root installs a user service
  --prepare-only      Prepare files/runtime without starting the node
  --help              Show this help
EOF
}

require_value() {
  option="$1"
  value="${2-}"
  if [ -z "$value" ]; then
    echo "Error: $option requires a non-empty value" >&2
    usage >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir=*) INSTALL_DIR="${1#*=}"; require_value --dir "$INSTALL_DIR" ;;
    --dir) shift; require_value --dir "${1-}"; INSTALL_DIR="$1" ;;
    --host=*) HOST="${1#*=}"; require_value --host "$HOST" ;;
    --host) shift; require_value --host "${1-}"; HOST="$1" ;;
    --pairing=*) PAIRING="${1#*=}" ;;
    --pairing) shift; require_value --pairing "${1-}"; PAIRING="$1" ;;
    --node-id=*) NODE_ID="${1#*=}"; require_value --node-id "$NODE_ID" ;;
    --node-id) shift; require_value --node-id "${1-}"; NODE_ID="$1" ;;
    -d|--detach) DETACH=1 ;;
    --install) INSTALL_SERVICE=1 ;;
    --prepare-only) PREPARE_ONLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [ -z "$INSTALL_DIR" ]; then
  echo "Error: --dir is required; the bootstrap never installs into the current directory implicitly" >&2
  usage >&2
  exit 1
fi
if [ -z "$HOST" ]; then
  echo "Error: --host is required because no request-derived default was available" >&2
  usage >&2
  exit 1
fi
if [ "$PREPARE_ONLY" = "1" ] && [ "$INSTALL_SERVICE" = "1" ]; then
  echo "Error: --prepare-only and --install cannot be used together" >&2
  exit 1
fi
carriage_return="$(printf '\r')"
case "$INSTALL_DIR" in
  *'
'*|*"$carriage_return"*) echo "Error: --dir must not contain newline characters" >&2; exit 1 ;;
esac

for cmd in curl tar node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required for bare-metal node bootstrap" >&2
    exit 1
  fi
done

HOST="${HOST%/}"
mkdir -p "$INSTALL_DIR"
ABS_INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
STATE_DIR="$ABS_INSTALL_DIR/data"
SOURCE_DIR="$ABS_INSTALL_DIR/foxwarm-node"
ENV_FILE="$ABS_INSTALL_DIR/.env"
LOG_FILE="$STATE_DIR/logs/node.log"
PID_FILE="$STATE_DIR/node.pid"
MODE_FILE="$STATE_DIR/node.mode"
LAUNCHER_FILE="$ABS_INSTALL_DIR/run-node-client.sh"
SYSTEMD_DIR="$ABS_INSTALL_DIR/systemd"
CREDENTIALS_FILE="$STATE_DIR/state/node_credentials.json"

mkdir -p "$STATE_DIR/state" "$STATE_DIR/agents" "$STATE_DIR/logs" "$SOURCE_DIR" "$SYSTEMD_DIR"

if [ -z "$PAIRING" ] && [ ! -s "$CREDENTIALS_FILE" ]; then
  echo "Error: --pairing is required for first-time setup when no stored credentials exist at $CREDENTIALS_FILE" >&2
  exit 1
fi

echo "Downloading node source bundle from $HOST/node/source.tar.gz ..."
curl -fsSL "$HOST/node/source.tar.gz" | tar -xzf - -C "$SOURCE_DIR"

NODE_CLIENT_ENTRYPOINT="$SOURCE_DIR/packages/cli-node/dist/client.bundle.js"
NODE_RUNTIME_DIR="$SOURCE_DIR/packages/cli-node-runtime"

if [ -f "$NODE_CLIENT_ENTRYPOINT" ]; then
  echo "Using bundled node client from source archive; skipping npm install."
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required when the downloaded bundle is missing" >&2
    exit 1
  fi
  echo "Bundled node client not found; building fallback in $SOURCE_DIR ..."
  (cd "$SOURCE_DIR/packages/shared" && npm ci && npm run build)
  (cd "$SOURCE_DIR/packages/cli-node" && npm ci && npm run build)
  NODE_CLIENT_ENTRYPOINT="$SOURCE_DIR/packages/cli-node/dist/client.bundle.js"
fi

if [ -f "$NODE_RUNTIME_DIR/package-lock.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "Installing the target-platform PTY runtime (node-pty only) ..."
    if ! npm --prefix "$NODE_RUNTIME_DIR" ci --omit=dev; then
      echo "Warning: node-pty installation failed; continuing without remote terminal capability." >&2
      echo "Linux requires Python 3, make, and a C/C++ compiler for node-pty." >&2
    fi
  else
    echo "Warning: npm is unavailable; continuing without remote terminal capability." >&2
  fi
fi

if [ ! -f "$NODE_CLIENT_ENTRYPOINT" ]; then
  NODE_CLIENT_ENTRYPOINT="$SOURCE_DIR/packages/cli-node/dist/client.js"
fi
if [ ! -f "$NODE_CLIENT_ENTRYPOINT" ]; then
  echo "Error: downloaded node client entrypoint is missing: $NODE_CLIENT_ENTRYPOINT" >&2
  exit 1
fi

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\"'\"'/g"
  printf "'"
}

NODE_BIN="$(command -v node)"
{
  echo '#!/bin/sh'
  echo 'set -eu'
  printf 'cd '; shell_quote "$SOURCE_DIR"; echo
  printf 'exec '; shell_quote "$NODE_BIN"
  printf ' '; shell_quote "$NODE_CLIENT_ENTRYPOINT"
  printf ' --host '; shell_quote "$HOST"
  printf ' --id '; shell_quote "$NODE_ID"
  if [ -n "$PAIRING" ]; then
    printf ' --token '; shell_quote "$PAIRING"
  fi
  printf ' --credentials-file '; shell_quote "$CREDENTIALS_FILE"
  echo
} > "$LAUNCHER_FILE"
chmod 700 "$LAUNCHER_FILE"

{
  printf 'NODE_HOST='; shell_quote "$HOST"; echo
  printf 'NODE_SOURCE_URL='; shell_quote "$HOST/node/source.tar.gz"; echo
  printf 'NODE_PAIRING_TOKEN='; shell_quote "$PAIRING"; echo
  printf 'NODE_ID='; shell_quote "$NODE_ID"; echo
  printf 'NODE_INSTALL_DIR='; shell_quote "$ABS_INSTALL_DIR"; echo
  printf 'NODE_DATA_DIR='; shell_quote "$STATE_DIR"; echo
  printf 'NODE_SOURCE_DIR='; shell_quote "$SOURCE_DIR"; echo
  printf 'NODE_CREDENTIALS_FILE='; shell_quote "$CREDENTIALS_FILE"; echo
  printf 'NODE_LOG_FILE='; shell_quote "$LOG_FILE"; echo
  printf 'NODE_PID_FILE='; shell_quote "$PID_FILE"; echo
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

Q_LAUNCHER_FILE="$(shell_quote "$LAUNCHER_FILE")"
Q_LOG_FILE="$(shell_quote "$LOG_FILE")"
Q_PID_FILE="$(shell_quote "$PID_FILE")"
Q_MODE_FILE="$(shell_quote "$MODE_FILE")"

echo "Installation root: $ABS_INSTALL_DIR"
echo "Prepared env file: $ENV_FILE"
echo "Persistent node data: $STATE_DIR"
echo "Source directory: $SOURCE_DIR"
echo "Credentials file: $CREDENTIALS_FILE"
echo "Log file: $LOG_FILE"

start_foreground() {
  exec "$LAUNCHER_FILE"
}

safe_node_name="$(printf '%s' "$NODE_ID" | sed 's/[^A-Za-z0-9_.-]/-/g; s/^-*//; s/-*$//')"
[ -n "$safe_node_name" ] || safe_node_name="node"
dir_checksum="$(printf '%s' "$ABS_INSTALL_DIR" | cksum | awk '{print $1}')"
TMUX_SESSION="foxwarm-node-$safe_node_name-$dir_checksum"

check_existing_process() {
  if [ -s "$PID_FILE" ]; then
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    case "$old_pid" in
      ''|*[!0-9]*) rm -f "$PID_FILE" "$MODE_FILE" ;;
      *)
        if kill -0 "$old_pid" 2>/dev/null; then
          echo "Error: node process already appears to be running with PID $old_pid" >&2
          exit 1
        fi
        rm -f "$PID_FILE" "$MODE_FILE"
        ;;
    esac
  fi
}

start_detached() {
  check_existing_process
  : > "$LOG_FILE"
  if command -v tmux >/dev/null 2>&1; then
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      echo "Error: tmux session already exists: $TMUX_SESSION" >&2
      exit 1
    fi
    tmux new-session -d -s "$TMUX_SESSION" -c "$SOURCE_DIR" "exec $Q_LAUNCHER_FILE >> $Q_LOG_FILE 2>&1"
    tmux_pid="$(tmux display-message -p -t "$TMUX_SESSION" '#{pane_pid}')"
    printf '%s\n' "$tmux_pid" > "$PID_FILE"
    printf 'tmux:%s\n' "$TMUX_SESSION" > "$MODE_FILE"
    sleep 1
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      echo "Error: node exited immediately; inspect $LOG_FILE" >&2
      exit 1
    fi
    echo "Background supervisor: tmux session $TMUX_SESSION"
    echo "Attach: tmux attach -t '$TMUX_SESSION'"
    echo "Stop:   tmux kill-session -t '$TMUX_SESSION'"
  else
    nohup "$LAUNCHER_FILE" </dev/null >> "$LOG_FILE" 2>&1 &
    detached_pid=$!
    printf '%s\n' "$detached_pid" > "$PID_FILE"
    printf 'nohup\n' > "$MODE_FILE"
    sleep 1
    if ! kill -0 "$detached_pid" 2>/dev/null; then
      echo "Error: node exited immediately; inspect $LOG_FILE" >&2
      exit 1
    fi
    echo "Background supervisor: nohup (tmux was not available)"
    echo "Stop: kill \"\$(cat $Q_PID_FILE)\" && rm -f $Q_PID_FILE $Q_MODE_FILE"
  fi
}

systemd_escape_value() {
  # Keep the leading slash literal (path directives validate it before fully
  # unescaping) and hex-escape characters meaningful to unit/ExecStart syntax.
  printf '%s' "$1" | sed \
    -e 's/\\/\\x5c/g' \
    -e 's/ /\\x20/g' \
    -e 's/	/\\x09/g' \
    -e 's/"/\\x22/g' \
    -e "s/'/\\\\x27/g" \
    -e 's/%/\\x25/g' \
    -e 's/\$/\\x24/g'
}

systemd_exec_quote() {
  printf '"'
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e 's/\$/$$/g' \
    -e 's/%/%%/g'
  printf '"'
}

install_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Error: --install requires systemd/systemctl" >&2
    exit 1
  fi

  if [ "$(id -u)" = "0" ]; then
    if ! systemctl show-environment >/dev/null 2>&1; then
      echo "Error: --install requires a running systemd system manager" >&2
      exit 1
    fi
    CONTROL_CMD="systemctl"
    SYSTEMCTL_SCOPE=""
    SCOPE_LABEL="system"
    WANTED_BY="multi-user.target"
    JOURNAL_SCOPE=""
    SERVICE_UNIT_DIR="/etc/systemd/system"
  else
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      echo "Error: no running systemd user manager is available for --install" >&2
      echo "Run from a normal login session, or rerun as root for a system service." >&2
      exit 1
    fi
    CONTROL_CMD="systemctl --user"
    SYSTEMCTL_SCOPE="--user"
    SCOPE_LABEL="user"
    WANTED_BY="default.target"
    JOURNAL_SCOPE="--user"
    SERVICE_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

    if command -v loginctl >/dev/null 2>&1; then
      login_name="${USER:-$(id -un)}"
      linger_state="$(loginctl show-user "$login_name" -p Linger --value 2>/dev/null || true)"
      if [ "$linger_state" != "yes" ]; then
        if loginctl enable-linger "$login_name" >/dev/null 2>&1; then
          echo "Enabled systemd lingering for $login_name so the user service can start at boot."
        else
          echo "Warning: could not enable lingering for $login_name." >&2
          echo "Run 'sudo loginctl enable-linger $login_name' for boot startup before login." >&2
        fi
      fi
    else
      echo "Warning: loginctl is unavailable; verify user lingering for boot startup before login." >&2
    fi
  fi

  SERVICE_NAME="foxwarm-node-$safe_node_name.service"
  GENERATED_UNIT="$SYSTEMD_DIR/$SERVICE_NAME"
  {
    echo '[Unit]'
    echo "Description=Foxwarm node $safe_node_name"
    echo 'After=network-online.target'
    echo 'Wants=network-online.target'
    echo
    echo '[Service]'
    echo 'Type=simple'
    printf 'WorkingDirectory='; systemd_escape_value "$SOURCE_DIR"; echo
    printf 'ExecStart=/bin/sh '; systemd_exec_quote "$LAUNCHER_FILE"; echo
    printf 'StandardOutput=append:'; systemd_escape_value "$LOG_FILE"; echo
    printf 'StandardError=append:'; systemd_escape_value "$LOG_FILE"; echo
    echo 'Restart=always'
    echo 'RestartSec=5'
    echo
    echo '[Install]'
    echo "WantedBy=$WANTED_BY"
  } > "$GENERATED_UNIT"
  chmod 644 "$GENERATED_UNIT"

  mkdir -p "$SERVICE_UNIT_DIR"
  SERVICE_FILE="$SERVICE_UNIT_DIR/$SERVICE_NAME"
  rm -f "$SERVICE_FILE"
  cp "$GENERATED_UNIT" "$SERVICE_FILE"
  chmod 644 "$SERVICE_FILE"
  systemctl $SYSTEMCTL_SCOPE daemon-reload
  systemctl $SYSTEMCTL_SCOPE enable "$SERVICE_NAME"
  systemctl $SYSTEMCTL_SCOPE restart "$SERVICE_NAME"

  cat <<EOF

Node client installed, enabled, and started as a $SCOPE_LABEL systemd service.
Service: $SERVICE_NAME
Installed unit: $SERVICE_FILE
Generated unit: $GENERATED_UNIT
Logs: tail -f $Q_LOG_FILE
      journalctl $JOURNAL_SCOPE -u '$SERVICE_NAME' -f
Lifecycle:
  $CONTROL_CMD status '$SERVICE_NAME'
  $CONTROL_CMD restart '$SERVICE_NAME'
  $CONTROL_CMD stop '$SERVICE_NAME'
  $CONTROL_CMD disable '$SERVICE_NAME'

The service runs the node in the foreground under systemd supervision; it does
not create a second tmux/nohup daemon layer.

If this is the first run, approve the pending pairing on the master:
  /node
  /node approve <pending-id> $NODE_ID
EOF
}

if [ "$PREPARE_ONLY" = "1" ]; then
  cat <<EOF

Preparation complete. The node process was not started.
Start in foreground:
  $Q_LAUNCHER_FILE
Start in background by rerunning this bootstrap with the same --dir and -d.
After first startup, approve the pending pairing with:
  /node approve <pending-id> $NODE_ID
EOF
  exit 0
fi

if [ "$INSTALL_SERVICE" = "1" ]; then
  check_existing_process
  install_systemd_service
elif [ "$DETACH" = "1" ]; then
  echo "Starting node client in background ..."
  start_detached
  cat <<EOF
PID file: $PID_FILE
Mode file: $MODE_FILE
Log file: $LOG_FILE
Follow logs: tail -f $Q_LOG_FILE
If this is the first run, approve it with: /node approve <pending-id> $NODE_ID
EOF
else
  cat <<EOF

Node client prepared. Starting in foreground below.
Press Ctrl-C to stop it. Use -d for background mode or --install for systemd startup.
If this is the first run, approve it on the master with:
  /node approve <pending-id> $NODE_ID
EOF
  start_foreground
fi
