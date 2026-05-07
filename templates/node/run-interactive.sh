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

cli-node TUI — connect to Foxwarm, confirm tool calls, and talk to bound sessions.

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

for cmd in curl tar node; do
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

NODE_TUI_ENTRYPOINT="$ABS_SOURCE_DIR/packages/cli-node/dist/tui.bundle.js"
if [ -f "$NODE_TUI_ENTRYPOINT" ]; then
  echo "Using bundled interactive node client from source archive; skipping npm install."
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required only when the downloaded bundle is missing and a source build fallback is needed" >&2
    exit 1
  fi
  echo "Bundled interactive node client not found; installing minimal package dependencies and building fallback ..."
  (cd "$ABS_SOURCE_DIR/packages/shared" && npm ci && npm run build)
  (cd "$ABS_SOURCE_DIR/packages/cli-node" && npm ci && npm run build)
  NODE_TUI_ENTRYPOINT="$ABS_SOURCE_DIR/packages/cli-node/dist/tui.bundle.js"
fi

# ─── Verify build ───
if [ ! -f "$NODE_TUI_ENTRYPOINT" ]; then
  NODE_TUI_ENTRYPOINT="$ABS_SOURCE_DIR/packages/cli-node/dist/tui.js"
fi
if [ ! -f "$NODE_TUI_ENTRYPOINT" ]; then
  echo "Error: cli-node TUI not found after build" >&2
  exit 1
fi

# ─── Build command ───
CMD="node '$NODE_TUI_ENTRYPOINT' --host '$HOST' --id '$NODE_ID'"

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
  echo "  /node"
  echo "  /node approve <pending-id> $NODE_ID"
fi

echo ""

# Run interactively (foreground, stdin attached)
exec sh -c "$CMD"
