#!/bin/sh

set -eu

HOST="__FOXWARM_DEFAULT_BASE_URL__"
PAIRING=""
NODE_ID="node-$(hostname 2>/dev/null || echo foxwarm-node)"
STATE_DIR="./data"
SOURCE_DIR="./foxwarm-node"
ENV_FILE="./.env"
PREPARE_ONLY=0
DETACH=0

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL http(s)://master/node/run.sh | bash -s -- \
    --pairing=PAIRING_TOKEN \
    --node-id=my-node

This is the bare-metal bootstrap path. It prepares a local node client checkout,
installs/builds it, and by default runs the node client in the foreground.

The script defaults `--host` from the URL used to fetch `/node/run.sh`.
Pass `--host=...` only when the node should connect to a different reachable master URL
(for example the script was fetched through localhost, a private address, or a reverse proxy path that is not the node's real target).

Options:
  --host=URL          Override Foxwarm master base URL (default: derived from request URL)
  --pairing=TOKEN     Pairing token for first-time setup; optional only if stored credentials already exist
  --node-id=ID        Requested node name (default: node-<hostname>)
  --state-dir=DIR     Persistent data dir on the local machine (default: ./data)
  --source-dir=DIR    Local source dir to extract/build the node client (default: ./foxwarm-node)
  --env-file=FILE     Env record file to create (default: ./.env)
  -d, --detach        Start in background and write logs to ./data/logs/node.log
  --prepare-only      Prepare files/install/build but do not start the node process
  --help              Show this help
EOF
}

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    --pairing=*) PAIRING="${arg#*=}" ;;
    --node-id=*) NODE_ID="${arg#*=}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --source-dir=*) SOURCE_DIR="${arg#*=}" ;;
    --env-file=*) ENV_FILE="${arg#*=}" ;;
    -d|--detach) DETACH=1 ;;
    --prepare-only) PREPARE_ONLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "Error: --host is required" >&2
  usage >&2
  exit 1
fi

for cmd in curl tar node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required for bare-metal node bootstrap" >&2
    exit 1
  fi
done

HOST="${HOST%/}"
CREDENTIALS_FILE="$STATE_DIR/state/node_credentials.json"
LOG_FILE="$STATE_DIR/logs/node.log"
PID_FILE="$STATE_DIR/node.pid"

mkdir -p "$STATE_DIR/state" "$STATE_DIR/agents" "$STATE_DIR/logs" "$SOURCE_DIR"

if [ -z "$PAIRING" ] && [ ! -s "$CREDENTIALS_FILE" ]; then
  echo "Error: --pairing is required for first-time setup when no stored credentials exist at $CREDENTIALS_FILE" >&2
  exit 1
fi

echo "Downloading node source bundle from $HOST/node/source.tar.gz ..."
curl -fsSL "$HOST/node/source.tar.gz" | tar -xzf - -C "$SOURCE_DIR"

ABS_STATE_DIR="$(cd "$STATE_DIR" && pwd)"
ABS_SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

cat > "$ENV_FILE" <<EOF
NODE_HOST=$HOST
NODE_SOURCE_URL=$HOST/node/source.tar.gz
NODE_PAIRING_TOKEN=$PAIRING
NODE_ID=$NODE_ID
NODE_DATA_DIR=$ABS_STATE_DIR
NODE_SOURCE_DIR=$ABS_SOURCE_DIR
NODE_CREDENTIALS_FILE=$ABS_STATE_DIR/state/node_credentials.json
NODE_LOG_FILE=$ABS_STATE_DIR/logs/node.log
NODE_PID_FILE=$ABS_STATE_DIR/node.pid
EOF

echo "Installing dependencies in $ABS_SOURCE_DIR ..."
(cd "$ABS_SOURCE_DIR" && npm ci)

if [ -f "$ABS_SOURCE_DIR/packages/cli-node/dist/client.js" ] && [ -f "$ABS_SOURCE_DIR/packages/shared/dist/toolResponseFormatting.js" ]; then
  echo "Using prebuilt node bundle from source archive."
else
  echo "Building node client in $ABS_SOURCE_DIR ..."
  (cd "$ABS_SOURCE_DIR" && npm run build)
fi

echo "Prepared env file: $ENV_FILE"
echo "Persistent node data: $ABS_STATE_DIR"
echo "Source directory: $ABS_SOURCE_DIR"
echo "Credentials file: $ABS_STATE_DIR/state/node_credentials.json"
echo "Log file: $ABS_STATE_DIR/logs/node.log"

start_foreground() {
  cd "$ABS_SOURCE_DIR"
  if [ -n "$PAIRING" ]; then
    exec node packages/cli-node/dist/client.js --host "$HOST" --id "$NODE_ID" --token "$PAIRING" --credentials-file "$ABS_STATE_DIR/state/node_credentials.json"
  fi
  exec node packages/cli-node/dist/client.js --host "$HOST" --id "$NODE_ID" --credentials-file "$ABS_STATE_DIR/state/node_credentials.json"
}

start_detached() {
  (
    cd "$ABS_SOURCE_DIR"
    if [ -n "$PAIRING" ]; then
      nohup node packages/cli-node/dist/client.js --host "$HOST" --id "$NODE_ID" --token "$PAIRING" --credentials-file "$ABS_STATE_DIR/state/node_credentials.json" >> "$ABS_STATE_DIR/logs/node.log" 2>&1 &
    else
      nohup node packages/cli-node/dist/client.js --host "$HOST" --id "$NODE_ID" --credentials-file "$ABS_STATE_DIR/state/node_credentials.json" >> "$ABS_STATE_DIR/logs/node.log" 2>&1 &
    fi
    echo $! > "$ABS_STATE_DIR/node.pid"
  )
}

if [ "$PREPARE_ONLY" = "1" ]; then
  cat <<EOF

Preparation complete. Node process was not started because --prepare-only was used.

Start later with:
  cd '$ABS_SOURCE_DIR' && node packages/cli-node/dist/client.js --host '$HOST' --id '$NODE_ID' ${PAIRING:+--token '$PAIRING'} --credentials-file '$ABS_STATE_DIR/state/node_credentials.json'

If this is the first run, approve the pending pairing after startup:
  /node
  /node approve <pending-id> $NODE_ID

EOF
  exit 0
fi

if [ "$DETACH" = "1" ]; then
  echo "Starting node client in background ..."
  start_detached
  sleep 1

  cat <<EOF

Node client prepared and started in background.

PID file:
  $ABS_STATE_DIR/node.pid

Log file:
  $ABS_STATE_DIR/logs/node.log

If this is the first run, approve the pending pairing on the master:
  /node
  /node approve <pending-id> $NODE_ID

Useful follow-up commands:
  tail -f '$ABS_STATE_DIR/logs/node.log'
  cat '$ABS_STATE_DIR/node.pid'

EOF
  exit 0
fi

cat <<EOF

Node client prepared. Starting in foreground below.

If this is the first run, approve the pending pairing on the master:
  /node
  /node approve <pending-id> $NODE_ID

Press Ctrl-C to stop the node process. Use -d/--detach if you want it to keep running in the background.

EOF

start_foreground