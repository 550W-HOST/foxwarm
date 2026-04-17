---
name: node_setup
description: Explain, bootstrap, and troubleshoot Foxwarm nodes, including pairing, sandbox nodes, and isolated-agent binding.
---

# node_setup

Use this skill when you need to explain, bootstrap, or troubleshoot a Foxwarm **node**.

This is the main skill for:

- what a node is
- how pairing / approval works
- how to start a node on Linux / Docker / Windows
- how isolated agents bind to nodes
- how sandbox/test nodes relate to ordinary nodes

There is also a structured builtin tool for agent workflows:

- `node_bootstrap_info`

Use that tool when you want LLM-friendly bootstrap info instead of re-parsing prose help text.

This skill matches the current bootstrap surfaces exposed by a running master:

- `/node/run.sh`
- `/node/run-docker.sh`
- `/node/run-interactive.sh`
- `/node/run.ps1`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

It does **not** use the removed old direct-registration flow.

## Mental model

A **node** is a remote Foxwarm execution worker.

After pairing/approval, a node can:

- receive tool calls from the master
- persist its own credentials/state locally
- reconnect automatically with stored per-node credentials

A **sandbox node** is still just a node.

The difference is usually deployment context / intended use:

- runs in a sandbox or Docker test environment
- often used for isolated agents
- may need test-environment-specific data-root settings

So the relationship is:

- **normal node** = general remote worker
- **sandbox node** = a node deployed in a sandbox/test environment
- **isolated agent** = an agent bound to a non-master node so its sessions inherit restricted execution

## Base URL principle

Foxwarm cannot reliably know one globally correct external base URL for every node bootstrap.

Depending on where the node runs, the reachable master URL might be:

- `http://localhost:3001`
- a LAN IP such as `http://192.168.x.x:3001`
- a Docker host IP
- a public reverse-proxy domain
- something else environment-specific

What Foxwarm **can** do is:

- when serving `/node/run.sh`, `/node/run-docker.sh`, or `/node/run.ps1`
- look at the **current HTTP request** (for example `Host` / forwarded proto)
- fill that request-derived URL into the downloaded script as the **default** host

Tool note:

- the `node_bootstrap_info` tool is intentionally **not** an API-style “tell me the exact external URL” interface
- it returns `$BASE_URL` placeholders in the places where a real reachable master address is needed
- it also explains that the caller/operator must choose `BASE_URL` from the node's point of view
- this keeps the tool aligned with reality: Foxwarm does not know one unique globally correct external address

So the rule is:

- if you fetch the bootstrap script from the same URL the node should later use, you usually do **not** need to pass `--host`
- if you fetched the script through a different address, pass `--host=...` explicitly

Example of choosing a reachable URL first:

```bash
BASE_URL=http://YOUR_MASTER:3001
```

## Pairing / approval flow

On first run, the node connects with a **pairing token** and creates a pending pairing request.

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

- the node stores credentials locally
- future restarts use stored node credentials
- the pairing token is mainly for first-time pairing / re-pairing

## Fastest startup: Linux bare-metal bootstrap

Use this when you want a direct host-side node client.

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

What it does:

- downloads `/node/source.tar.gz`
- extracts it into `./foxwarm-node/`
- writes `./.env`
- creates local state under `./data/`
- runs `npm ci`
- uses the prebuilt bundle from the archive when available
- builds only if required artifacts are missing
- starts the node client in the **foreground by default**

If you want background mode instead:

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node \
  -d
```

Override the host explicitly only when needed:

```bash
curl -fsSL "http://127.0.0.1:3001/node/run.sh" | bash -s -- \
  --host=http://192.168.1.50:3001 \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

## Interactive Linux bootstrap

Use this when every tool call should require local confirmation:

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run-interactive.sh" | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-interactive-node
```

Optional extras:

- `--auto-approve=REGEX`
- `--timeout=SECONDS`

## Docker bootstrap

Use this when you want the node in a containerized environment.

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

That path:

- writes `./docker-compose.yaml`
- writes `./.env`
- creates `./data/`
- starts the container
- **follows logs by default** so startup/pairing is visible immediately

If you want it to return immediately without following logs:

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node \
  -d
```

## Manual docker-compose template flow

If you want to inspect or customize before starting:

```bash
BASE_URL=http://YOUR_MASTER:3001
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

Why this works:

- the compose file contains an inline Dockerfile
- it downloads `/node/source.tar.gz` during build
- the node bundle includes prebuilt runtime artifacts and shared-package files needed by the current node client
- the remote machine does not need a full Foxwarm checkout first

## Windows bootstrap

```powershell
irm http://YOUR_MASTER:3001/node/run.ps1 | iex
```

That downloaded script also defaults `HostUrl` from the request URL.
Override `-HostUrl` only when needed.

## Where data goes

By default, local node deployment state is written in the **current directory**:

- `./.env`
- `./data/`
- `./foxwarm-node/`

Inside `./data/`, the most important persisted files are:

- `./data/state/node_credentials.json` — paired node credentials
- `./data/agents/` — node-side agent workspace/data
- `./data/logs/` — node-side logs/artifacts

## Bind isolated agents to a node

### Create a new isolated agent bound to a node

```text
/agent create <agent-name> --isolated <node-id>
```

Example:

```text
/agent create sandbox-agent --isolated sandbox-docker
```

### Change an existing agent to isolated mode

```text
/agent isolated <agent-name> <node-id>
```

### Disable isolation again

```text
/agent isolated <agent-name> off
```

Important behavior:

- isolated agents must bind to a **non-master** node
- isolated sessions inherit isolation automatically from the agent
- isolated agents may still use `master` for limited in-agent host-side operations
- current master-side file boundary is the whole current agent directory

## Sandbox/test-environment note

A sandbox node is often used for isolated agents in testing.

The most important testing pitfall is the data root.

For the main Foxwarm testing environment, the sandbox node must use:

```text
FOXWARM_DATA_DIR=/app/test
```

Why this matters:

- the testing runtime stores data under `/app/test/state` and `/app/test/agents`
- if the sandbox node uses `/app` instead, it will read/write the wrong state tree
- then `/node`, node online state, file behavior, and test results become misleading

So when sandbox behavior looks wrong, check the data root before debugging pairing/permissions.

## Verification checklist

After startup and approval:

1. `/node known` shows the node as approved
2. `/node` shows it online
3. if using isolated agents, confirm the agent is actually bound to that node
4. confirm tool execution is happening on the expected node, not accidentally on `master`
5. confirm restricted cross-agent/cross-node behavior when isolation is expected

## Common troubleshooting

### Node never appears online

Check:

- local process / container logs
- `/node pair list`
- `/node known`
- whether the chosen host URL is actually reachable from the node

### Node bundle builds or runs oddly

Current bootstrap expects `/node/source.tar.gz` to provide the node client bundle plus the shared package artifacts needed by the current runtime.
If you are debugging an older deployment or stale extracted directory, re-download/re-extract the bundle before assuming the problem is deeper.

### Credentials seem stale

Remove or reset the stored credentials file and pair again:

```bash
rm -f ./data/state/node_credentials.json
```

Then restart and re-approve.

### Sandbox node acts like it sees the wrong files/state

First suspect `FOXWARM_DATA_DIR` mismatch.
For testing, it must point at `/app/test`, not `/app`.

## Related skill

Use **`agent_management`** when the task is mainly about:

- why agent rename/delete behave the way they do
- safe agent migration / cleanup
- snapshot refresh after editing another agent's memory
