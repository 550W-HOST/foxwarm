---
name: isolated_sandbox_setup
description: Guide for starting and troubleshooting a sandbox node for isolated-agent and testing workflows.
---

# isolated_sandbox_setup

Use this skill to help a user set up a **sandbox node** for safer testing, isolated-agent execution, and restricted remote workflows.

This skill is the sandbox-focused companion to the general node bootstrap flow.

## What this skill is for

Use a sandbox node when you want:

- a dedicated node for isolated agents
- safer test execution away from `master`
- a clearly separated worker such as `sandbox-docker`
- a node that can be bound to agents via `/agent create --isolated ...`

## Fast bootstrap flow

The current preferred startup path is still the same master-provided bootstrap flow:

```bash
curl -fsSL http://YOUR_MASTER:3001/node/run.sh | bash -s -- \
  --host=http://YOUR_MASTER:3001 \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=sandbox-docker
```

By default this writes local state into the current directory:

- `./docker-compose.yaml`
- `./.env`
- `./data/`

That means sandbox credentials/state normally live under:

- `./data/state/node_credentials.json`

## Manual compose flow

If you want to review/edit first:

```bash
curl -fsSL http://YOUR_MASTER:3001/node/docker-compose.yaml -o docker-compose.yaml

cat > .env <<'EOF'
NODE_HOST=http://YOUR_MASTER:3001
NODE_SOURCE_URL=http://YOUR_MASTER:3001/node/source.tar.gz
NODE_PAIRING_TOKEN=YOUR_PAIRING_TOKEN
NODE_ID=sandbox-docker
NODE_DATA_DIR=./data
EOF

docker compose up -d --build
```

## First-run approval flow

After the container starts, approve the pending pairing from the master:

```text
/node pair list
/node pair approve <pending-id> sandbox-docker
```

Then confirm it:

```text
/node known
/node
```

## Bind isolated agents to the sandbox node

### Create a new isolated agent on the sandbox node

```text
/agent create <agent-name> --isolated sandbox-docker
```

Example:

```text
/agent create sandbox-agent --isolated sandbox-docker
```

### Change an existing agent to isolated mode

```text
/agent isolated <agent-name> sandbox-docker
```

Disable isolation again:

```text
/agent isolated <agent-name> off
```

## Current isolation behavior to remember

- isolated agents must bind to a **non-master** node
- isolated sessions inherit isolation from the agent automatically
- isolated agents may still use `master` for limited host-side operations
- current master-side file boundary is the whole current agent directory:
  - `agents/<agent-name>/*`
- they cannot access other agents' directories on master
- they cannot freely target unrelated nodes

## Testing-environment pitfall: `FOXWARM_DATA_DIR`

This is the most important sandbox/testing deployment pitfall.

For the **main testing environment**, the sandbox node must use:

```text
FOXWARM_DATA_DIR=/app/test
```

Why:

- the testing runtime stores data under `/app/test/state` and `/app/test/agents`
- if the sandbox node uses the default `/app` data root instead,
  it will look at `/app/state` and `/app/agents`
- then `/node`, node online state, remote file behavior, and test results become misleading or inconsistent

### Practical testing note

The `sandbox-docker` node used in testing should be understood as:

- same source tree mounted at `/app`
- testing data root forced to `/app/test`
- credentials stored separately from the main testing master state

If sandbox behavior looks wrong, verify this first before debugging pairing or permissions.

## Suggested verification checklist

After startup and approval:

1. `/node known` shows the node as approved
2. `/node` shows it online
3. create/open a session under an isolated agent bound to that node
4. confirm execution uses the sandbox node, not `master`
5. confirm cross-agent operations are rejected
6. confirm master-side file access is limited to that agent's own directory

## Common sandbox troubleshooting

### Node approved but behavior looks like wrong data / wrong files

First suspect `FOXWARM_DATA_DIR` mismatch.

For testing, it must point at `/app/test`, not `/app`.

### Node appears online but isolated behavior is inconsistent

Check:

- the agent is actually isolated and bound to the sandbox node
- the node id matches what `/node known` and `/node` show
- the sandbox container is using the correct mounted data directory

### Re-pair if necessary

If sandbox credentials are stale, clear the local credentials file and restart the container:

```bash
rm -f ./data/state/node_credentials.json
docker compose restart
```

Then approve the pending request again.

## Relationship to the general node skill

- use **`node_setup`** when the task is “start a normal remote node”
- use **`isolated_sandbox_setup`** when the task is “start or debug a sandbox node for isolated/test execution”
