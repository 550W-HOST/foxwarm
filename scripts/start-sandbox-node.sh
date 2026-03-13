#!/bin/sh

set -eu

NODE_MASTER_URL="${NODE_URL:-http://foxwarm:3001}"
NODE_IDENTIFIER="${NODE_ID:-sandbox-node}"
NODE_TOKEN_PATH="${NODE_TOKEN_FILE:-/app/state/node_token}"
EXPLICIT_NODE_TOKEN="${NODE_TOKEN:-}"

if [ -n "$EXPLICIT_NODE_TOKEN" ] && [ "$EXPLICIT_NODE_TOKEN" != "PLACEHOLDER_TOKEN" ]; then
  RESOLVED_NODE_TOKEN="$EXPLICIT_NODE_TOKEN"
else
  echo "Waiting for node token at $NODE_TOKEN_PATH..."
  while [ ! -s "$NODE_TOKEN_PATH" ]; do
    sleep 1
  done
  RESOLVED_NODE_TOKEN="$(tr -d '\r\n' < "$NODE_TOKEN_PATH")"
fi

echo "Waiting for foxwarm master at $NODE_MASTER_URL..."
until curl --noproxy "*" -fsS "${NODE_MASTER_URL%/}/login.html" >/dev/null 2>&1; do
  sleep 1
done

exec node lib/nodeClient.js \
  --host "$NODE_MASTER_URL" \
  --id "$NODE_IDENTIFIER" \
  --token "$RESOLVED_NODE_TOKEN"
