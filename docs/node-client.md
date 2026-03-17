# Node client quick start

Foxwarm can expose helper endpoints for bootstrapping a generic node client from a running master:

- `/node/run.sh`
- `/node/run-docker.sh`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

## Bare-metal one-command bootstrap

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
- `./foxwarm-node/` (downloaded source + built node client)

Important persisted path:

- `./data/state/node_credentials.json`

Then approve the pending node from the master:

```text
/node pair list
/node pair approve <pending-id> my-node
```

By default, the bare-metal script also:

- downloads `/node/source.tar.gz`
- extracts it into `./foxwarm-node/`
- runs `npm ci`
- runs `npm run build`
- starts `node lib/nodes/client.js` in the background

If you only want preparation without starting, use:

```bash
curl -fsSL http://localhost:3002/node/run.sh | bash -s -- \
  --host=http://localhost:3002 \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  --prepare-only
```

## Docker bootstrap script

If you want the Docker-based path instead, use:

```bash
curl -fsSL http://localhost:3002/node/run-docker.sh | bash -s -- \
  --host=http://localhost:3002 \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

This writes `./docker-compose.yaml`, `./.env`, and `./data/`, then runs:

```bash
docker compose up -d --build
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

The current compose template is self-contained:

- it does **not** need a local `Dockerfile.node`
- it uses an inline Dockerfile in the compose file itself
- during build, that inline Dockerfile downloads `/node/source.tar.gz`

So the remote machine does not need a local Foxwarm checkout first.

## Minimal troubleshooting

Check local status first:

```bash
docker compose ps
docker compose logs -f
```

Then check the master-side node state:

```text
/node pair list
/node known
/node
```

If approval succeeded but reconnect still fails, inspect or remove:

```text
./data/state/node_credentials.json
```