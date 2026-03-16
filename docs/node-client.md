# Node client quick start

Foxwarm can expose helper endpoints for bootstrapping a generic node client from a running master:

- `/node/run.sh`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

## One-command bootstrap

```bash
curl -fsSL http://localhost:3002/node/run.sh | bash -s -- \
  --host=http://localhost:3002 \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

This writes the following into the current directory by default:

- `./docker-compose.yaml`
- `./.env`
- `./data/` (credentials, agent data, logs)

Then approve the pending node from the master:

```text
/node pair list
/node pair approve <pending-id> my-node
```

## Manual compose flow

```bash
curl -fsSL http://localhost:3002/node/docker-compose.yaml -o docker-compose.yaml
cat > .env <<'EOF'
NODE_HOST=http://localhost:3002
NODE_SOURCE_URL=http://localhost:3002/node/source.tar.gz
NODE_PAIRING_TOKEN=YOUR_PAIRING_TOKEN
NODE_ID=my-node
NODE_DATA_DIR=./data
EOF

docker compose up -d --build
```

The current compose template builds the node image from `/node/source.tar.gz`, so the remote machine does not need a local foxwarm checkout.