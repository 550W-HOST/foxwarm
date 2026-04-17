#!/bin/sh

set -eu

HOST="__FOXWARM_DEFAULT_BASE_URL__"
PAIRING=""
NODE_ID="node-$(hostname 2>/dev/null || echo foxwarm-node)"
STATE_DIR="./data"
SOURCE_DIR="./foxwarm-node"
AUTO_APPROVE=""
TIMEOUT=""
EXTRA_ARGS=""

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL http(s)://master/node/run-interactive.sh | bash -s -- \
    --pairing=PAIRING_TOKEN \
    --node-id=macbook

Interactive node client — every tool call requires your confirmation.

The script defaults `--host` from the URL used to fetch `/node/run-interactive.sh`.
Pass `--host=...` only when the node should connect to a different reachable master URL.

Options:
  --host=URL              Override Foxwarm master base URL (default: derived from request URL)
  --pairing=TOKEN         Pairing token for first-time setup
  --node-id=ID            Node name (default: node-<hostname>)
  --state-dir=DIR         Persistent data dir (default: ./data)
  --source-dir=DIR        Source dir for node client (default: ./foxwarm-node)
  --auto-approve=REGEX    Auto-approve tools matching regex (e.g. "read|browse_list")
  --timeout=SECONDS       Auto-reject after N seconds of no input
  --help                  Show this help

Examples:
  # Full interactive (confirm everything):
  curl ... | bash -s -- --pairing=TOKEN --node-id=macbook

  # Auto-approve read-only tools:
  curl ... | bash -s -- --pairing=TOKEN --node-id=macbook \
    --auto-approve="read|browse_list|browse_get"

  # Auto-reject after 60s of no input:
  curl ... | bash -s -- --pairing=TOKEN --node-id=macbook --timeout=60
EOF
}

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    --pairing=*) PAIRING="${arg#*=}" ;;
    --node-id=*) NODE_ID="${arg#*=}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --source-dir=*) SOURCE_DIR="${arg#*=}" ;;
    --auto-approve=*) AUTO_APPROVE="${arg#*=}" ;;
    --timeout=*) TIMEOUT="${arg#*=}" ;;
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
    echo "Error: $cmd is required" >&2
    exit 1
  fi
done

HOST="${HOST%/}"
CREDENTIALS_FILE="$STATE_DIR/state/node_credentials.json"

mkdir -p "$STATE_DIR/state" "$STATE_DIR/agents" "$STATE_DIR/logs" "$SOURCE_DIR"

if [ -z "$PAIRING" ] && [ ! -s "$CREDENTIALS_FILE" ]; then
  echo "Error: --pairing is required for first-time setup (no stored credentials at $CREDENTIALS_FILE)" >&2
  exit 1
fi

# ─── Download & build ───
ABS_STATE_DIR="$(cd "$STATE_DIR" && pwd)"
ABS_SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

echo "Downloading node source from $HOST/node/source.tar.gz ..."
curl -fsSL "$HOST/node/source.tar.gz" | tar -xzf - -C "$ABS_SOURCE_DIR"

echo "Installing dependencies ..."
(cd "$ABS_SOURCE_DIR" && npm ci)

if [ -f "$ABS_SOURCE_DIR/lib/nodes/interactive-client.js" ] && [ -f "$ABS_SOURCE_DIR/packages/shared/dist/toolResponseFormatting.js" ]; then
  echo "Using prebuilt node bundle from source archive."
else
  echo "Building ..."
  (cd "$ABS_SOURCE_DIR" && npm run build)
fi

# ─── Verify build ───
if [ ! -f "$ABS_SOURCE_DIR/lib/nodes/interactive-client.js" ]; then
  echo "Error: interactive-client.js not found after build" >&2
  exit 1
fi

# ─── Build command ───
CMD="node '$ABS_SOURCE_DIR/lib/nodes/interactive-client.js' --host '$HOST' --id '$NODE_ID'"

if [ -n "$PAIRING" ]; then
  CMD="$CMD --token '$PAIRING'"
fi

CMD="$CMD --credentials-file '$ABS_STATE_DIR/state/node_credentials.json'"

if [ -n "$AUTO_APPROVE" ]; then
  CMD="$CMD --auto-approve '$AUTO_APPROVE'"
fi

if [ -n "$TIMEOUT" ]; then
  CMD="$CMD --timeout '$TIMEOUT'"
fi

echo ""
echo "Starting interactive node client ..."
echo "  Source:      $ABS_SOURCE_DIR"
echo "  State:       $ABS_STATE_DIR"
echo "  Credentials: $ABS_STATE_DIR/state/node_credentials.json"
echo ""

if [ -z "$PAIRING" ] || [ -s "$ABS_STATE_DIR/state/node_credentials.json" ]; then
  echo "Using stored credentials."
else
  echo "First run — after startup, approve on master:"
  echo "  /node pair list"
  echo "  /node pair approve <pending-id> $NODE_ID"
fi

echo ""

# Run interactively (foreground, stdin attached)
exec sh -c "$CMD"
