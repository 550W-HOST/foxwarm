---
name: node-setup
description: "Set up and troubleshoot Foxwarm Nodes, configure optional Providers including disposable containers, or run delegated development work on a Node with Task and Git delivery examples."
---

# node-setup

Use this skill to explain, bootstrap, troubleshoot, or coordinate development work on a Foxwarm **Node**.

## Choose a workflow

- **Delegated development work:** read [the development workflow](references/development-workflow.md) and its runnable [ToolScript example](examples/development_workflow.py): provisioning a fresh Node, source/material transfer, Task assignment, committed or evidence-only delivery, review and explicit release.
- **Disposable environments:** read [the container Provider guide](examples/container/README.md). It creates one Docker or Podman container per Node from administrator-defined profiles, without network access. Registration is administrator opt-in.
- **Existing Linux machines:** read [the Linux SSH adapter guide](examples/linux-ssh/README.md). It includes opt-in registration for existing hosts; it is neither a default backend nor an OS/network sandbox. Python 3 and OpenSSH are administrator prerequisites.
- **Pairing and bootstrap:** use the sections below. Policy syntax belongs to `access-control`; Agent lifecycle, local rules and restricted-worker templates belong to `agent-management`.

## First: tools vs commands

This distinction matters here too.

### Tools are agent-facing

Examples in this area include:

- `ctl node bootstrap-info` (`node_bootstrap_info`)
- `ctl node pair-list` (`node_pair_list`)
- `ctl node pair-approve` (`node_pair_approve`)
- `ctl node token` (`node_create_auth_token`)
- `ctl node remove` (`node_remove`)
- `ctl node list`
- general inspection such as `ctl help`, `ctl tool search`, `ctl skill load`, file tools, etc.

These `ctl` commands are the agent's tool front end; policy rules name the builtin in parentheses.

Use tools when you need agent-side reasoning help or machine-readable/bootstrap-ready information.

### Commands are user-facing

Examples in this area include:

- `/node`
- `/node pair-approve ...`
- `/node token <node-id>`
- `/node pair-reject ...`
- `/node bootstrap-info`

Do **not** assume you should execute those user commands yourself as an agent.

Default rule:

- use tools for agent-side work
- if a workflow step really depends on the user command surface, tell the user exactly what to run
- do not treat simulated WebUI/API command injection as the normal path

This is the main skill for:

- what a node is
- how pairing / approval works
- how to start a node on Linux / Docker / Windows
- where delegated and risky work should run

There is also a structured builtin tool for agent workflows:

- `node_bootstrap_info`

Use that tool when you want LLM-friendly bootstrap info instead of re-parsing prose help text.
It requires `filePath`: an absolute path on master for a new owner-only file that receives
the pairing token. The returned commands contain the placeholder `PAIRING_TOKEN` (for example
`--pairing='PAIRING_TOKEN'`) instead of the token. The token isn't returned to you:
the user, or a command run where that file is readable, substitutes the file's contents when
running the command on the new Node. Choose a new path each time; an existing file is not
replaced.
The pairing and agent-management helpers are `ctl node` commands; `ctl node --help`
lists them.

When this skill shows `/node ...` examples below, read them as **commands for the user to run on the master side** unless the surrounding text explicitly says otherwise.

This skill matches the current bootstrap surfaces exposed by a running master:

- `/node/run.sh`
- `/node/run-docker.sh`
- `/node/run-interactive.sh`
- `/node/run.ps1`
- `/node/run-shell.ps1`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

It does **not** use the removed unauthenticated direct-registration flow. `/node token` is a separate pre-approved, per-node-credential flow.

## Mental model

A **Node** is an execution environment that tools can target: `master` (where the Main server runs), a paired CLI Node, an exec-only Shell Node, or a Node supplied by a configured **Provider**. Providers either list existing machines (such as the SSH adapter) or create Nodes on request (such as the container adapter, through `node` `create`/`ensure`/`destroy`).

After pairing and approval, a CLI or Shell Node receives tool calls from the Main server, keeps its own credentials and reconnects with them.

Keep three controls apart:

- **Placement** chooses where tools run: a Session's current Node, set at creation with `create_child_session({node})` or `ctl session create --node`, by `ctl node select`, or by an Agent's `defaultNode`. It grants nothing.
- **Authorization** decides which tools a Session may use on which Nodes: the global tool policy plus Agent-local rule layers (`access-control`, `agent-management`).
- **Containment** comes from the environment itself: a container, VM or separate machine and its account, network and resource limits. Foxwarm does not turn a Node into a sandbox by selecting it or by restricting an Agent.

## Where risky work should run

Run untrusted or risky work, such as code from an unreviewed repository or an Agent answering a public chat, in an environment whose damage stays contained, not on `master`:

- for delegated tasks, a fresh Node per assignment from a Provider that creates environments, such as the [container Provider](examples/container/README.md), released after review;
- for a long-lived assistant, one reserved Node (an `ensure`d container, VM or dedicated machine) set as its Agent's `defaultNode`;
- in both cases, an Agent-local allowlist that keeps the Agent's tools on its current Node. `agent-management` has restricted-worker and channel-assistant templates.

## Base URL principle

Foxwarm cannot infer one globally correct external base URL for every node bootstrap unless the operator supplies a public URL in top-level config:

```yaml
url: https://foxwarm.example.invalid/foxwarm
```

The configured URL supplies `/node bootstrap-info` and `node_bootstrap_info` examples, including the deployment path. It must be an absolute HTTP(S) URL without credentials, query or fragment; edits require a restart. Without it, each example contains a replaceable `YOUR_MASTER` address and can be copied independently.

Depending on where the node runs, the reachable master URL might be:

- `http://localhost:3001`
- a LAN IP such as `http://192.168.x.x:3001`
- a Docker host IP
- a public reverse-proxy domain
- something else environment-specific

What Foxwarm **can** do is:

- when serving `/node/run.sh`, `/node/run-docker.sh`, or `/node/run.ps1`
- look at the **current HTTP request** (for example `Host` / forwarded proto)
- fill that request-derived **origin** into the downloaded script as the **default** host, even when `config.url` is set

Tool note:

- the `node_bootstrap_info` tool is intentionally **not** an API-style “tell me the exact external URL” interface
- it returns complete configured addresses when available; otherwise replace `YOUR_MASTER` in the command you copy
- it writes the pairing token to its `filePath` and shows `PAIRING_TOKEN` in the commands; substitute the file's contents
- commands are independently copyable; check that the address is reachable from the new Node
- a configured public URL is not a guarantee that every node can reach it

So the rule is:

- if you fetch the bootstrap script from the same origin the node should later use, you usually do **not** need to pass `--host`
- if the public URL has a path prefix, pass `--host=YOUR_REACHABLE_URL` (or Windows `-HostUrl`) to preserve it; request headers cannot recover that path
- if you fetched the script through a different address, pass `--host=...` explicitly

Copy a setup command from `/node bootstrap-info` and replace its example address if necessary.

## Pairing / approval flow

Two supported paths are available. For a Node created before the remote client runs, the master-side user command is:

```text
/node token my-node
```

It reserves `my-node` and returns the per-node auth token once. Do not confuse this with the shared pairing token. The token is not a six-digit pairing code; the server stores only its hash. Use it on a new host with `--node-id=my-node --auth-token=YOUR_PER_NODE_AUTH_TOKEN` (Windows `-NodeId my-node -AuthToken YOUR_PER_NODE_AUTH_TOKEN`). The client saves credentials on successful registration; later runs use the credentials file. For URLs with a deployment path also pass `--host=YOUR_REACHABLE_URL` or `-HostUrl`. `/node remove my-node` is the user-facing credential-revocation command; agent workflows use `ctl node remove` below.

For an agent-managed setup, run `ctl node token <node-id> --file-path <path>`
(`node_create_auth_token`). This is separate from `ctl node create`: the
latter runs a configured provider lifecycle,
while this tool reserves a new approved Node ID and writes its credential to a
new owner-only file on master. It returns only `{ nodeId, filePath }`; it never
returns the token. The Node ID and destination file must both be new, and this
tool does not rotate an existing credential.

Keep the file path private and pass only file paths, host names, and Node IDs to
the existing `exec`/SSH or file-transfer tools. A concise local ToolScript
pattern is:

```python
def main(args):
    created = call_tool(
        toolId="builtin:node_create_auth_token",
        args={"nodeId": "my-node", "filePath": "/secure/new-node.token"},
    )
    # Run this on master, using the existing exec/SSH facilities. The command
    # reads the protected file as needed; do not print its contents or return
    # the nested exec result.
    call_tool(
        source="node",
        nodeId="master",
        name="exec",
        args={"command": "scp -- '/secure/new-node.token' 'node-host:/secure/new-node.token'"},
    )
    return {"nodeId": created["nodeId"], "filePath": created["filePath"], "transfer": "requested"}
```

Adjust the transfer and Node startup command for the target deployment. Do not
put the token in a command argument, environment interpolation visible to the
tool call, script output, or a captured `cat`; avoid shell tracing such as
`set -x`. The protected file may remain on master until the operator moves or
deletes it.

For the existing request/approve path, start the Node with the shared pairing token:

On first run, the node connects with a **pairing token** and creates a pending pairing request.
The Node startup log includes the exact `/node pair-approve <pending-id>` command; there is no six-digit pairing code to compare.

### Agent-facing approval

A coordinator allowed to use the pairing tools can discover and call them:

1. `ctl node pair-list`
2. after checking the pending id, `ctl node pair-approve <pending-id> --node-id <node-id>`

Approval establishes trust in a new execution host. Even though the tool path
can automate it, keep a human confirmation step when the operator's policy
requires one. Do not approve an unexplained pending request merely because it
appears in the list.

### Remove an approved Node

For agent-managed credential revocation, pass the approved Node ID explicitly:

```text
node remove my-node
```

It returns `{ nodeId, disconnected }`. Main removes the approved credential and
any unclaimed approved pairing handoff, then disconnects the active connection
if present. The old credential can no longer authenticate. Offline approved
Nodes can also be removed; `disconnected: false` means no runtime connection
was present. Reserved, invalid, and unknown IDs fail rather than selecting the
current Node.

This does not stop the client process, delete files or containers, remove Agents
or Sessions, or change their Node bindings. Provider resource destruction is a
separate `ctl node destroy` operation. Review affected bindings
before revocation and handle any authorized deployment cleanup separately.
Use this tool rather than injecting `/node remove` through a WebUI/API command
entry point. The `/node remove <node-id>` command remains available for users.

### User-facing approval

If approval should remain on the user command surface, tell the user to run:

```text
/node
/node pair-approve <pending-id> --node-id my-node
```

Useful follow-up checks:

```text
/node
```

After approval:

- the node stores credentials locally
- future restarts use stored node credentials
- the pairing token is mainly for first-time pairing / re-pairing

`ctl node list` is the agent-facing online-node check. A node that is approved but
offline will not be usable for worker execution and may not appear there.

## Fastest startup: Linux bare-metal bootstrap

Use this when you want a direct host-side node client.

```bash
curl -fsSL 'http://YOUR_MASTER:3001/node/run.sh' | bash -s -- \
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
- uses the prebuilt bundle from the archive when available
- skips shared/CLI dependency installation and builds when `client.bundle.js` is present
- separately attempts `npm ci --omit=dev` for the optional PTY runtime; failure continues without remote terminal capability
- only when `client.bundle.js` is missing, requires npm and runs the shared/CLI install-and-build fallback
- starts the node client in the **foreground by default**

If you want background mode instead:

```bash
curl -fsSL 'http://YOUR_MASTER:3001/node/run.sh' | bash -s -- \
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
curl -fsSL 'http://YOUR_MASTER:3001/node/run.sh' | bash -s -- \
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
curl -fsSL 'http://YOUR_MASTER:3001/node/run-interactive.sh' | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-cli-node
```

Optional extras:

- `--auto-approve=REGEX`
- `--timeout=SECONDS`

## Docker bootstrap

Use this when you want the node in a containerized environment.

```bash
curl -fsSL 'http://YOUR_MASTER:3001/node/run-docker.sh' | bash -s -- \
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
curl -fsSL 'http://YOUR_MASTER:3001/node/run-docker.sh' | bash -s -- \
  --pairing=YOUR_PAIRING_TOKEN \
  --node-id=my-node \
  -d
```

## Exec-only Shell Node

For a device that needs only command execution without Node.js, use the independent POSIX-shell client. It requires `sh`, `curl`, and `mktemp`, `mkfifo`, `dd`, `wc`, `head`, `tail`, `cat`, `mv`, `rm`, `mkdir`, `chmod`, `sleep`, `date`, `sed`, and `tr`. Its startup checks are authoritative: BusyBox builds can omit applets, and this workflow does not promise compatibility with every router or install packages.

First run `/node token my-shell` on the master and save the returned per-node token privately. The global pairing token is not a Shell Node credential. Run from the desired default command directory:

```sh
curl -fsSL 'https://foxwarm.example.invalid/foxwarm/node/run-shell.sh' | NODE_AUTH_TOKEN=YOUR_PER_NODE_AUTH_TOKEN sh -s -- --host='https://foxwarm.example.invalid/foxwarm' --node-id=my-shell
```

Always passing `--host` preserves any deployment prefix. Curl retains certificate verification. The token is kept in an owner-only temporary curl config and Authorization headers, not URLs. The script installs no runtime or service and creates no Agent directories.

For Windows, choose **Windows Shell** in the administrator onboarding modal, or invoke the Windows PowerShell 5.1 client in memory. It uses inbox .NET Framework, requires FullLanguage PowerShell, and needs no Node.js:

```powershell
& ([ScriptBlock]::Create((Invoke-WebRequest -UseBasicParsing -Uri 'https://foxwarm.example.invalid/foxwarm/node/run-shell.ps1').Content)) -HostUrl 'https://foxwarm.example.invalid/foxwarm' -NodeId 'my-shell' -AuthToken 'YOUR_PER_NODE_AUTH_TOKEN'
```

Both Shell methods require a pre-created per-node credential. Windows commands run in separate PowerShell processes with literal Windows cwd handling, private bounded command files, continuously drained pipes and fixed-size output samples. The Windows client has the same exec-only transport and completion ownership as the POSIX client; it installs no service.

Use the normal Node selector or `/node select my-shell`; ordinary `exec` then targets this Node. Only `exec` is advertised. Omitted and relative cwd use its startup directory; `cd` does not carry over between calls. File tools, Code/Git/PTY/backend services and external-owner execution are unavailable.

The foreground wait defaults to 15 seconds, clamps above 60, and rounds fractions upward to a whole second. Timeout returns an exec ID without killing the command. Normal `wait` can use that ID; completion goes to the originating Session and includes bounded first/last 4096-byte samples, total output bytes and exit code. The initial background response contains the continuation notice, not a running-output snapshot. Full logs and a read-exec API do not exist. The FIFO collector continuously drains output without growing a full log or closing the command pipe during truncation.

Each command's wrapper owns its foreground budget, background transition and report retries independently; the main loop keeps polling while jobs run. There is no additional client concurrency cap; Main bounds unfinished dispatches and output stays bounded per command. Network errors retry reports only, never the command itself. Main/client restart can leave an unknown outcome; there is no durable queue, outbox or crash continuation. Revocation/stop does not kill active commands. The existing 24-hour completion boundary stops reporting but does not remove a still-running FIFO/collector. Restart the client explicitly after a lost registration. For agent-managed revocation when finished, use `call_tool({ toolId: "builtin:node_remove", args: { nodeId: "my-shell" } })`; users can still run `/node remove my-shell`. See [Node client quick start](../../docs/node-client.md#shell-only-node) for the complete limitations.

## Manual docker-compose template flow

If you want to inspect or customize before starting:

```bash
curl -fsSL 'http://YOUR_MASTER:3001/node/docker-compose.yaml' -o docker-compose.yaml
umask 077
cat > .env <<'FOXWARM_NODE_ENV'
NODE_HOST='http://YOUR_MASTER:3001'
NODE_SOURCE_URL='http://YOUR_MASTER:3001/node/source.tar.gz'
NODE_PAIRING_TOKEN='YOUR_PAIRING_TOKEN'
NODE_ID='my-node'
NODE_DATA_DIR=./data
FOXWARM_NODE_ENV
chmod 600 .env

docker compose up -d --build
```

Why this works:

- the compose file contains an inline Dockerfile
- it downloads `/node/source.tar.gz` during build
- the node bundle includes prebuilt runtime artifacts and shared-package files needed by the current node client
- the remote machine does not need a full Foxwarm checkout first

## Windows bootstrap

```powershell
& ([ScriptBlock]::Create((Invoke-WebRequest -UseBasicParsing -Uri 'http://YOUR_MASTER:3001/node/run.ps1').Content)) -HostUrl 'http://YOUR_MASTER:3001' -Pairing 'PAIRING_TOKEN' -NodeId 'my-pc'
```

That downloaded script also defaults `HostUrl` from the request URL.
Override `-HostUrl` only when needed.

The bootstrap is downloaded into memory and its parameters are bound separately. CLI programs and state remain installed. In-memory invocation uses the caller directory for default source/state paths. For a saved `run.ps1`, node-owned agent and exec-capture state is bound to
`<StateDir>\agents`, and the Node client starts from the directory containing
the script rather than inheriting the caller's project cwd. The bootstrap
overrides inherited agent-directory environment values so `StateDir` remains
the deployment-state boundary.

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

## Legacy isolated Agents

Agents that were bound to a Node with legacy isolation are migrated at startup to a local rule layer with that Node as `defaultNode`. See [agent-management: Legacy isolated Agents](../agent-management/references/OPERATIONS.md#legacy-isolated-agents).

## Verification checklist

After startup and approval:

1. use `ctl node list` to confirm the node is online, or tell the user to run `/node` when approved/offline detail is needed
2. if approval is pending, use the reviewed `node_pair_list` / `node_pair_approve` tool path or the user-facing `/node pair-approve` path
3. confirm tool execution happens on the expected Node, not accidentally on `master`
4. for restricted Agents, check representative allowed and denied calls with `explain_tool_authorization`

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

### The Main server in a container shows unexpected Agents or state

Check the `FOXWARM_DATA_DIR` its compose file sets; a different data directory is a different installation state.

## Related skills

Use **`agent-management`** for Agent creation, local rules, the restricted-worker and channel-assistant templates, migration, cleanup and snapshot refresh. Use **`access-control`** for policy syntax and identities.

## WebUI onboarding

Open **System Architecture → Nodes**. This view shows Node identity, type, connection/compatibility status and available services without Session rows or inspectors. **New nodes** opens setup methods for Linux CLI, interactive CLI, Shell, Docker and Windows. The address defaults to `config.url`, or the current browser address including its deployment path. You can explicitly change it for the new Node's network.

Copy a setup command and keep it private. CLI clients using pairing appear in **Pending approvals**; approve only requests you recognize. The button's pending count excludes already approved clients waiting to reconnect. Shell setup instead requires an explicit **Create** action, which reserves a Node name and shows its one-time per-node credential in the command. Copy that command before closing; closing the dialog discards its credentials.
