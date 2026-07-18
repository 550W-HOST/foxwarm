---
name: node-setup
description: "Use for Foxwarm node setup and troubleshooting: node pairing/approval flow, bootstrap scripts, sandbox nodes, and binding/unbinding isolated agents to nodes."
---

# node-setup

Use this skill when you need to explain, bootstrap, or troubleshoot a Foxwarm **node**.

## First: tools vs commands

This distinction matters here too.

### Tools are agent-facing

Examples in this area include:

- `node_bootstrap_info`
- `node_pair_list`
- `node_pair_approve`
- `list_nodes`
- general inspection tools such as `search_tools`, `load_skill`, file tools, etc.

Use tools when you need agent-side reasoning help or machine-readable/bootstrap-ready information.

### Commands are user-facing

Examples in this area include:

- `/node`
- `/node approve ...`
- `/node reject ...`
- `/node pair-help`
- `/agent create ... --isolated ...`
- `/agent isolated ...`

Do **not** assume you should execute those user commands yourself as an agent.

Default rule:

- use tools for agent-side work
- if a workflow step really depends on the user command surface, tell the user exactly what to run
- do not treat simulated WebUI/API command injection as the normal path

This is the main skill for:

- what a node is
- how pairing / approval works
- how to start a node on Linux / Docker / Windows
- how isolated agents bind to nodes
- how sandbox/test nodes relate to ordinary nodes

There is also a structured builtin tool for agent workflows:

- `node_bootstrap_info`

Use that tool when you want LLM-friendly bootstrap info instead of re-parsing prose help text.
The pairing and agent-management helpers are not all injected into the default
tool schema. Discover them with `search_tools`, then invoke them with
`call_tool`.

When this skill shows `/node ...` examples below, read them as **commands for the user to run on the master side** unless the surrounding text explicitly says otherwise.

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

Do not confuse these three controls:

- `create_child_session({ node: "..." })` changes a session's `currentNode` for
  ordinary remote execution; it does **not** isolate that session
- `isolatedNode` is agent-level metadata; every session in that agent inherits
  the same isolation boundary and bound node
- a separate VM/container is an operator-provided environment boundary; Foxwarm
  does not create that compute resource merely by binding an agent

## What isolated agents are mainly for

Use an isolated agent when you want to put work onto a separate node to reduce risk to `master`.

In ordinary language, this is mainly for cases like:

- potentially risky tasks you do not want running directly on `master`
- agents attached to external group chats / channels that may contain untrusted content
- situations where prompt injection or other hostile content is a realistic concern

The idea is not that an isolated agent becomes magically safe.
The idea is that you give it a narrower execution boundary:

- full runtime/tool use on its bound isolated node
- only limited file/memory operations on `master`

So isolated agents are a practical containment tool for higher-risk workflows.

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

### Agent-facing approval

A non-isolated coordinator can discover and use the pairing tools:

1. `search_tools({ query: "pair node", sources: ["builtin"] })`
2. `call_tool({ toolId: "builtin:node_pair_list", args: {} })`
3. after checking the pending id, `call_tool({ toolId: "builtin:node_pair_approve", args: { pendingId, nodeId } })`

Approval establishes trust in a new execution host. Even though the tool path
can automate it, keep a human confirmation step when the operator's policy
requires one. Do not approve an unexplained pending request merely because it
appears in the list.

### User-facing approval

If approval should remain on the user command surface, tell the user to run:

```text
/node
/node approve <pending-id> my-node
```

Useful follow-up checks:

```text
/node
```

After approval:

- the node stores credentials locally
- future restarts use stored node credentials
- the pairing token is mainly for first-time pairing / re-pairing

`list_nodes` is the agent-facing online-node check. A node that is approved but
offline will not be usable for worker execution and may not appear there.

## Fastest startup: Linux bare-metal bootstrap

Use this when you want a direct host-side node client.

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

What it does:

- downloads `/node/source.tar.gz`
- requires an explicit installation root through `--dir` (it never silently uses the current directory)
- extracts source into `<dir>/foxwarm-node/`
- writes `<dir>/.env`
- creates local state under `<dir>/data/`
- runs `npm ci`
- uses the prebuilt bundle from the archive when available
- builds only if required artifacts are missing
- starts the node client in the **foreground by default**

If you want background mode instead:

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node \
  -d
```

`-d` prefers a detached tmux session. If tmux is unavailable, it falls back to
`nohup`, records a PID, and redirects output to `<dir>/data/logs/node.log`. The
script prints the exact status/log/stop commands for the selected mode.

For systemd-managed startup and restart supervision:

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node \
  --install
```

`--install` requires a running systemd manager. Root installs a system service
under `/etc/systemd/system/`; non-root installs a user service under
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`. The user path also checks
systemd lingering so the service can start before login. The installed service
runs the node in the foreground under systemd supervision (no nested tmux/nohup).
Its generated source unit remains under `<dir>/systemd/`, while source, env,
data, logs, PID metadata, and launcher remain under the explicit `<dir>`.

Override the host explicitly only when needed:

```bash
curl -fsSL "http://127.0.0.1:3001/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --host=http://192.168.1.50:3001 \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node
```

## cli-node TUI Linux bootstrap

Use this when every tool call should require local confirmation:

```bash
BASE_URL=http://YOUR_MASTER:3001
curl -fsSL "$BASE_URL/node/run-interactive.sh" | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-cli-node
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

Bare-metal `run.sh` requires `--dir` and writes deployment state only beneath
that explicit installation root:

- `<dir>/.env`
- `<dir>/data/`
- `<dir>/foxwarm-node/`
- `<dir>/run-node-client.sh`
- `<dir>/systemd/` (generated unit source when `--install` is used)

Inside `<dir>/data/`, the most important persisted files are:

- `<dir>/data/state/node_credentials.json` — paired node credentials
- `<dir>/data/agents/` — node-side agent workspace/data
- `<dir>/data/logs/` — node-side logs/artifacts

## Bind isolated agents to a node

These `/agent ...` examples below are **user-facing commands**.
If you have a suitable tool surface, the corresponding agent-facing operations are usually:

- `create_agent` with `isolatedNode`
- `set_agent_isolated`

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
- isolation is agent-level, not session-level
- isolated sessions inherit isolation automatically from the agent
- isolated agents may still use `master` for limited in-agent host-side operations
- on `master`, the practical writable/readable boundary is their own agent area:
  - their own `memory/` via memory tools
  - files inside their own agent directory (`agents/<agent>/...`) via the allowed file tools
- they do **not** get ordinary freedom to roam across other agents' files on `master`
- they do **not** get ordinary freedom to switch to or operate unrelated nodes

### Node/permission boundary

For an isolated agent, the boundary is:

- **allowed:** the bound isolated node and its tool surface
- **allowed:** limited host-side operations on `master`, but only for the isolated agent's own memory and agent-directory files
- **not allowed:** switching to another node
- **not allowed:** using unrelated nodes
- **not allowed:** reading/writing other agents' directories on `master`

An isolated agent cannot switch itself to another node.
If a workflow really needs another node, the user should change the agent's isolation binding deliberately instead of the isolated agent using other nodes directly.

Binding does not reserve a node. Multiple sessions or agents can target the same
node unless the operator provides distinct nodes and maintains that assignment.

For the repeatable “one temporary isolated agent/session on an existing node”
workflow, load **`isolated-worker`**. Its bundled ToolScript composes
`create_agent`, `create_session`, and `send_to_session`; it does not provision
or tear down the node/container.

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

1. use `list_nodes` to confirm the node is online, or tell the user to run `/node` when approved/offline detail is needed
2. if approval is pending, use the reviewed `node_pair_list` / `node_pair_approve` tool path or the user-facing `/node approve` path
3. if using isolated agents, confirm the agent is actually bound to that node
4. confirm tool execution is happening on the expected node, not accidentally on `master`
5. confirm restricted cross-agent/cross-node behavior when isolation is expected

## Common troubleshooting

### Node never appears online

Check:

- local process / container logs
- the output of the user-facing `/node` command
- whether the chosen host URL is actually reachable from the node

### Node bundle builds or runs oddly

Current bootstrap expects `/node/source.tar.gz` to provide the node client bundle plus the shared package artifacts needed by the current runtime.
If you are debugging an older deployment or stale extracted directory, re-download/re-extract the bundle before assuming the problem is deeper.

### Credentials seem stale

Remove or reset the stored credentials file and pair again:

```bash
rm -f /opt/foxwarm-node/data/state/node_credentials.json
```

Then restart and re-approve.

### Sandbox node acts like it sees the wrong files/state

First suspect `FOXWARM_DATA_DIR` mismatch.
For testing, it must point at `/app/test`, not `/app`.

## Related skill

Use **`agent-management`** when the task is mainly about:

- why agent rename/delete behave the way they do
- safe agent migration / cleanup
- snapshot refresh after editing another agent's memory

Use **`isolated-worker`** when a coordinator should create a temporary isolated
agent/session on a user-provided, already connected node.
