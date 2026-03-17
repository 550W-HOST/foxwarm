---
name: node_setup
description: Bootstrap and troubleshoot a general-purpose Foxwarm node with run.sh, docker-compose template, and pairing approval flow.
---

# node_setup

Use this skill when you need to explain, bootstrap, or troubleshoot a **normal remote Foxwarm node**.

This skill matches the current deployment flow based on:

- `/node/run.sh`
- `/node/run-docker.sh`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

It does **not** describe the removed old direct-registration flow.

## What this skill is for

A normal node is a remote Foxwarm execution worker that can:

- connect to a Foxwarm master over pairing-based node auth
- receive tool calls from the master
- persist its credentials/state locally
- reconnect automatically after approval

Use this when the goal is simply:

- “start a node on another Linux machine quickly”
- “pair a node with a running Foxwarm master”
- “understand where credentials/state/logs go”

## Fastest startup: bare-metal one command

```bash
curl -fsSL http://YOUR_MASTER:3001/node/run.sh | bash -s -- \
  --host=http://YOUR_MASTER:3001 \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

What this does:

- downloads `/node/source.tar.gz`
- extracts it into `./foxwarm-node/`
- writes `./.env`
- creates local state under `./data/`
- runs `npm ci` and `npm run build`
- starts the node client locally in the background by default

## Where data goes

By default, node deployment state is written in the **current directory**:

- `./.env`
- `./data/`
- `./foxwarm-node/`

Inside `./data/`, the important persisted files are:

- `./data/state/node_credentials.json` — paired node credentials
- `./data/agents/` — node-side agent workspace/data
- `./data/logs/` — node-side logs/artifacts

If needed, `run.sh` also supports:

- `--state-dir=DIR`
- `--source-dir=DIR`
- `--env-file=FILE`
- `--prepare-only`

## Docker bootstrap alternative

If you explicitly want the Docker-based path instead, use:

```bash
curl -fsSL http://YOUR_MASTER:3001/node/run-docker.sh | bash -s -- \
  --host=http://YOUR_MASTER:3001 \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

That path writes:

- `./docker-compose.yaml`
- `./.env`
- `./data/`

and then runs `docker compose up -d --build`.

## docker-compose template flow

If you want to inspect or customize before starting, use the template directly:

```bash
curl -fsSL http://YOUR_MASTER:3001/node/docker-compose.yaml -o docker-compose.yaml

cat > .env <<'EOF'
NODE_HOST=http://YOUR_MASTER:3001
NODE_SOURCE_URL=http://YOUR_MASTER:3001/node/source.tar.gz
NODE_PAIRING_TOKEN=YOUR_PAIRING_TOKEN
NODE_ID=my-node
NODE_DATA_DIR=./data
EOF

docker compose up -d --build
```

Why this works:

- the compose file contains an inline Dockerfile, so no separate local `Dockerfile.node` is needed
- that inline Dockerfile downloads `/node/source.tar.gz` during build
- the remote machine does **not** need a local Foxwarm git checkout first

## First startup: approve pairing on the master

On first run, the node connects with the pairing token and creates a pending pairing request.

Approve it from the master:

```text
/node pair list
/node pair approve <pending-id> my-node
```

Useful follow-up checks:

```text
/node known
/node
```

After approval:

- the node stores credentials in `./data/state/node_credentials.json`
- it reconnects with per-node credentials
- future restarts do not require repeating approval unless credentials are cleared/rejected

## Recommended troubleshooting checklist

### 1. Check local container status

```bash
docker compose ps
docker compose logs -f
```

### 2. Check whether the node is still pending approval

On the master:

```text
/node pair list
```

### 3. Check whether the node is approved but offline

On the master:

```text
/node known
/node
```

### 4. Check credentials path

Expected default location:

```text
./data/state/node_credentials.json
```

If the file is missing after approval, inspect container logs and verify the data directory mount.

### 5. Re-pair cleanly if needed

If credentials are stale or invalid, remove the local data directory or credentials file and start again:

```bash
rm -f ./data/state/node_credentials.json
docker compose restart
```

Then re-approve from the master if required.

## Common pitfalls

- Do **not** use the old removed direct-registration idea of `?token=...&id=...` as a final authenticated mode.
- The pairing token is only for the initial approval flow; long-term reconnect uses stored credentials.
- State is local to the current directory by default; changing directories changes where `./data` lives.
- If compose comes up but the node never appears online, check container logs first, then `/node pair list` and `/node known`.
