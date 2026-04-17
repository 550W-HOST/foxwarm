#!/bin/sh

set -eu

HOST="__FOXWARM_DEFAULT_BASE_URL__"
PAIRING=""
NODE_ID="node-$(hostname 2>/dev/null || echo foxwarm-node)"
STATE_DIR="./data"
COMPOSE_FILE="./docker-compose.yaml"
ENV_FILE="./.env"
DETACH=0

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL http(s)://master/node/run-docker.sh | bash -s -- \
    --pairing=PAIRING_TOKEN \
    --node-id=my-node

This is the Docker bootstrap path. It downloads the compose template,
prepares local state in the current directory, starts the node container, and by default follows logs.

The script defaults `--host` from the URL used to fetch `/node/run-docker.sh`.
Pass `--host=...` only when the container should connect to a different reachable master URL.

Options:
  --host=URL          Override Foxwarm master base URL (default: derived from request URL)
  --pairing=TOKEN     Pairing token from the master (required unless stored credentials already exist)
  --node-id=ID        Requested node name (default: node-<hostname>)
  --state-dir=DIR     Persistent data dir on the local machine (default: ./data)
  --compose-file=FILE docker compose file path to create (default: ./docker-compose.yaml)
  --env-file=FILE     env file path to create (default: ./.env)
  -d, --detach        Start container and return immediately without following logs
  --help              Show this help
EOF
}

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    --pairing=*) PAIRING="${arg#*=}" ;;
    --node-id=*) NODE_ID="${arg#*=}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --compose-file=*) COMPOSE_FILE="${arg#*=}" ;;
    --env-file=*) ENV_FILE="${arg#*=}" ;;
    -d|--detach) DETACH=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "Error: --host is required" >&2
  usage >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required" >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE='docker-compose'
else
  echo "Error: docker compose is required (docker compose or docker-compose)" >&2
  exit 1
fi

HOST="${HOST%/}"
mkdir -p "$STATE_DIR/state" "$STATE_DIR/agents" "$STATE_DIR/logs"

curl -fsSL "$HOST/node/docker-compose.yaml" -o "$COMPOSE_FILE"

cat > "$ENV_FILE" <<EOF
NODE_HOST=$HOST
NODE_SOURCE_URL=$HOST/node/source.tar.gz
NODE_PAIRING_TOKEN=$PAIRING
NODE_ID=$NODE_ID
NODE_DATA_DIR=$STATE_DIR
NODE_CREDENTIALS_FILE=/data/state/node_credentials.json
EOF

ABS_STATE_DIR="$(cd "$STATE_DIR" && pwd)"

echo "Created: $COMPOSE_FILE"
echo "Created: $ENV_FILE"
echo "Persistent node data: $ABS_STATE_DIR"
echo "Credentials file will be stored at: $ABS_STATE_DIR/state/node_credentials.json"

echo "Starting node client with: $DOCKER_COMPOSE up -d --build"
sh -c "$DOCKER_COMPOSE up -d --build"

if [ "$DETACH" = "1" ]; then
cat <<EOF

Docker-based node client started.

If this is the first run, approve the pending pairing on the master:
  /node pair list
  /node pair approve <pending-id> $NODE_ID

Useful follow-up commands:
  $DOCKER_COMPOSE logs -f
  $DOCKER_COMPOSE ps

EOF
  exit 0
fi

cat <<EOF

Docker-based node client started. Following logs below.

If this is the first run, approve the pending pairing on the master:
  /node pair list
  /node pair approve <pending-id> $NODE_ID

Press Ctrl-C to stop following logs. The container will keep running because it was started detached.

EOF

exec sh -c "$DOCKER_COMPOSE logs -f"