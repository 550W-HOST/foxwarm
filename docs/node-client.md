# Node client quick start

Foxwarm can expose helper endpoints for bootstrapping a generic node client from a running master:

- `/node/run.sh`
- `/node/run-docker.sh`
- `/node/run-interactive.sh`
- `/node/run.ps1`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

## Base URL principle

Foxwarm does **not** reliably know one universally correct external base URL for every node.
The reachable URL depends on where the node runs:

- same machine: `http://localhost:3002`
- LAN: `http://192.168.x.x:3002`
- Docker host IP
- reverse-proxy/public domain
- other environment-specific routing

What Foxwarm can do is fill a **request-derived default** into the downloaded bootstrap script based on the current HTTP request (`Host` / forwarded proto).

So the practical rule is:

- if you fetch `/node/run.sh`, `/node/run-docker.sh`, or `/node/run.ps1` from the same reachable URL the node should later use, you usually do **not** need to pass `--host`
- if you fetched the script through one address but the node should connect through another, pass `--host=...` explicitly

Use a placeholder like this in examples:

```bash
BASE_URL=http://YOUR_MASTER:3002
```

## Bare-metal one-command bootstrap

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

This writes the following into the current directory by default:

- `./.env`
- `./data/` (credentials, agent data, logs)
- `./foxwarm-node/` (downloaded source + built/prebuilt node client)

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
- uses the prebuilt bundle from the archive when available
- runs `npm run build` only if required artifacts are missing
- starts `node lib/nodes/client.js` in the **foreground**

If you want background mode instead:

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  -d
```

If the script was fetched through the wrong address, override the host explicitly:

```bash
curl -fsSL "http://127.0.0.1:3002/node/run.sh" | bash -s -- \
  --host="http://192.168.1.50:3002" \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

If you only want preparation without starting, use:

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  --prepare-only
```

## Interactive bootstrap script

Use this when every tool call should require local confirmation:

```bash
curl -fsSL "$BASE_URL/node/run-interactive.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-interactive-node
```

Optional extras:

```bash
--auto-approve="read|browse_list|browse_get"
--timeout=60
```

## Docker bootstrap script

If you want the Docker-based path instead, use:

```bash
curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

This writes `./docker-compose.yaml`, `./.env`, and `./data/`, then:

- starts the container in detached mode internally
- follows logs by default so startup/pairing is visible immediately

If you want it to return immediately instead of following logs:

```bash
curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  -d
```

## Manual compose flow

```bash
curl -fsSL "$BASE_URL/node/docker-compose.yaml" -o docker-compose.yaml
cat > .env <<'EOF'
NODE_HOST=$BASE_URL
NODE_SOURCE_URL=$BASE_URL/node/source.tar.gz
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
- the source bundle includes the shared-package artifacts needed by the current runtime
- the remote machine does not need a full local Foxwarm checkout first

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
