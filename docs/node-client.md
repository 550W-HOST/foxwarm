# Node client quick start

Foxwarm can expose helper endpoints for bootstrapping a generic node client from a running master:

- `/node/run.sh`
- `/node/run-shell.sh` (independent exec-only POSIX shell client)
- `/node/run-docker.sh`
- `/node/run-interactive.sh`
- `/node/run.ps1`
- `/node/docker-compose.yaml`
- `/node/source.tar.gz`

## Base URL principle

Optionally set a public URL at the **top level** of the application config (not under `bot`):

```yaml
url: https://foxwarm.example.invalid/foxwarm
```

`/node pair-help` and `node_bootstrap_info` use this URL in their examples and download endpoints. The URL must be an absolute HTTP(S) address with no username, password, query, or fragment. A trailing slash is removed; a deployment path is retained. Restart the server after editing config. If omitted, the examples keep a `BASE_URL` placeholder for the operator to fill in.

Without a configured URL, Foxwarm does **not** reliably know one universally correct external base URL for every node.
The reachable URL depends on where the node runs:

- same machine: `http://localhost:3002`
- LAN: `http://192.168.x.x:3002`
- Docker host IP
- reverse-proxy/public domain
- other environment-specific routing

The downloaded bootstrap script always receives a **request-derived default** based on its actual HTTP request (`Host` / forwarded proto), even when `url` is configured. This allows a script fetched from a LAN address to use that LAN address by default. The request alone cannot reveal a reverse-proxy deployment path.

So the practical rule is:

- if you fetch `/node/run.sh`, `/node/run-docker.sh`, or `/node/run.ps1` from the same reachable URL the node should later use, you usually do **not** need to pass `--host`
- if `url` includes a path such as `/foxwarm`, pass `--host="$BASE_URL"` (or PowerShell `-HostUrl $BASE_URL`) so the Node connects through that path
- if you fetched the script through one address but the node should connect through another, pass `--host=...` explicitly

Use a placeholder like this in examples:

```bash
BASE_URL=http://YOUR_MASTER:3002
```

When a public URL is configured, `/node pair-help` provides the corresponding `BASE_URL` assignment and explicit host flag when the path requires it.

## Start a Node with a pre-created credential

Run this **master-side command** before starting the Node:

```text
/node create my-node
```

It reserves `my-node` and returns its per-node auth token **once**. Save it privately. It is different from the global pairing token and the removed six-digit display code. The server stores only its hash. Then on the new Node:

```bash
BASE_URL=https://foxwarm.example.invalid/foxwarm
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --host="$BASE_URL" \
  --node-id=my-node \
  --auth-token=YOUR_PER_NODE_AUTH_TOKEN
```

For an origin-only URL omit `--host`; the downloaded script infers its default from the request. Docker and interactive launchers accept the same `--node-id` and `--auth-token` flags; on Windows use `-NodeId` and `-AuthToken`, plus `-HostUrl` for a deployment path. Initial authenticated registration writes an owner-only credentials file; later restarts can use that file without either command-line token. `/node remove my-node` revokes it.

Alternatively, start a new Node with the global pairing token as shown below. It reports a complete `/node approve <pending-id>` command in the startup log; copy that exact command into the master. This flow remains available alongside `/node create`.

## Shell-only Node

Use this client when you only need commands and do not want to install Node.js. It needs POSIX `sh`, `curl`, and these basic programs: `mktemp`, `mkfifo`, `dd`, `wc`, `head`, `tail`, `cat`, `mv`, `rm`, `mkdir`, `chmod`, `sleep`, `date`, `sed`, and `tr`. Startup checks each program and reports missing dependencies. BusyBox often supplies these utilities, but individual builds can omit them; this is not a guarantee for every router or OpenWrt image. The client does not install packages or create a service.

On the master, first reserve the Node and save its per-node token privately:

```text
/node create my-shell
```

From the desired default working directory on the Linux device:

```sh
BASE_URL=https://foxwarm.example.invalid/foxwarm
curl -fsSL "$BASE_URL/node/run-shell.sh" -o run-shell.sh
NODE_AUTH_TOKEN=YOUR_PER_NODE_AUTH_TOKEN sh ./run-shell.sh \
  --host="$BASE_URL" --node-id=my-shell
```

The explicit host preserves a reverse-proxy deployment prefix. Normal curl certificate verification remains enabled. The shared pairing token cannot authenticate this client. Its per-node bearer is sent in headers through a private temporary curl configuration, not in URLs or ordinary client logs.

Select `my-shell` using the normal Node selector or `/node my-shell`, then call ordinary `exec`. This Node advertises only `exec`, with command/cwd/timeout. It has no file tools, Code/Git/PTY services, Agent storage directories, or external-owner execution. Omitted cwd uses the startup directory, relative cwd resolves there, and a command's `cd` does not change the next command's default.

The default foreground wait is 15 seconds, values above 60 are clamped, and fractional waits are rounded up to the next second. A command exceeding the wait keeps running; its initial response contains the existing exec ID, and completion is reported to the original Session even if its selected Node has changed. The retained output sample and total byte count arrive with completion. Use the returned exec ID with normal `wait`; there is no running-output/read-exec endpoint.

Output is drained continuously into a FIFO collector. At most the first and last 4096 bytes are retained, with an exact total-byte count, exit code, and truncation notice. Short samples do not duplicate the overlapping middle. Binary samples are displayed as bounded hexadecimal. Full logs are not retained, and an infinite or no-newline stream does not grow an unbounded log file. Temporary sample files remain bounded per command. Each job independently waits and reports, so foreground commands, background commands and report retries do not stop task polling. The server bounds unfinished dispatches.

Only result reports are retried after a lost network response; commands already handed out are never redispatched. A missed response, lost Main process context, or client crash can leave the outcome unknown. There is no durable task queue, persisted completion outbox, or crash continuation. Stop/restart the client explicitly after a lost registration. Stopping or revoking a Node does not kill already-running commands; use an explicit command or the device's process controls when that is needed. Report authorization ends after 24 hours, but an active FIFO/collector is not removed until the command exits. Finished temporary state is then removed.

`/node remove my-shell` revokes the credential and disconnects the polling runtime. Keep the token outside public scripts and shell history; the environment placeholder above is only an example.

## Bare-metal one-command bootstrap

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

`--dir` is required; `run.sh` never silently installs into the current directory.
It writes all local deployment artifacts beneath that explicit root:

- `<dir>/.env`
- `<dir>/data/` (credentials, agent data, logs, PID/mode metadata)
- `<dir>/foxwarm-node/` (downloaded source + built/prebuilt node client)
- `<dir>/run-node-client.sh` (foreground launcher)
- `<dir>/systemd/` (generated unit source for `--install`)

Important persisted path:

- `<dir>/data/state/node_credentials.json`

When pairing starts, the Node log prints the exact approval command. Run it on the master; the optional node ID shown here assigns a particular final ID:

```text
/node approve <pending-id> my-node
```

## Client compatibility

The Master and Node client negotiate a core Node-protocol generation during pairing and authenticated registration. This version covers the coupled execution wire contract; it is separate from individual tool schemas and Code service versions.

An outdated Node may authenticate and remain connected for heartbeat/status, but Foxwarm marks it **upgrade required** and will not select it, advertise its tools/services, or dispatch work to it. `/node list` and Architecture show this state explicitly. Update the Node from the current Master's bootstrap/source bundle and restart it; approved credentials remain valid, so re-pairing is not normally required.

A current Node client also rejects an old Master that omits a compatible negotiation response, rather than appearing ready until a later tool call fails.

By default, the bare-metal script also:

- downloads `/node/source.tar.gz`
- extracts it into `./foxwarm-node/`
- uses the prebuilt bundle from the archive when available
- runs `npm run build` only if required artifacts are missing
- runs `npm ci --omit=dev` only in the separate `packages/cli-node-runtime` package to install official `node-pty` for optional remote Code terminals
- starts `node packages/cli-node/dist/client.js` in the **foreground**

Official `node-pty` includes macOS/Windows prebuilds but not Linux prebuilds. On Linux, remote terminal support therefore requires npm, Python 3, make, and a C/C++ compiler so node-gyp can build it. If this optional install fails, bare-metal bootstrap prints a warning and starts the node without `vscode-pty`; filesystem, Git, and normal model tools remain available.

When `vscode-pty` is available, each Foxwarm-created terminal gets a terminal-scoped `code` helper in its `PATH`. It is generated by the node runtime and talks only to a local Unix socket/capability; it is not installed globally and does not replace the machine's normal `code` command outside Foxwarm terminals. File/folder requests are relayed through the authenticated node connection to an attached Code browser.

If you want background mode instead:

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  -d
```

Detached mode prefers tmux and prints the session/attach/stop commands. If tmux
is unavailable it falls back to `nohup`, records `<dir>/data/node.pid`, and
writes output to `<dir>/data/logs/node.log`.

For boot startup and systemd restart supervision:

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  --install
```

Root installs `/etc/systemd/system/foxwarm-node-my-node.service`; non-root
prefers `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/foxwarm-node-my-node.service`
and checks user lingering for startup before login. The service directly runs
the foreground launcher with `Restart=always`; it does not nest tmux or nohup.
Node output remains in `<dir>/data/logs/node.log`.

If the script was fetched through the wrong address, override the host explicitly:

```bash
curl -fsSL "http://127.0.0.1:3002/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --host="http://192.168.1.50:3002" \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node
```

If you only want preparation without starting, use:

```bash
curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-node \
  --prepare-only
```

## cli-node TUI bootstrap script

Use this when every tool call should require local confirmation:

```bash
curl -fsSL "$BASE_URL/node/run-interactive.sh" | bash -s -- \
  --pairing="$(cat test/state/node_token)" \
  --node-id=my-cli-node
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
COMPOSE_BASE_URL=$(printf '%s' "$BASE_URL" | sed "s/'/\\\\'/g")
cat > .env <<EOF
NODE_HOST='$COMPOSE_BASE_URL'
NODE_SOURCE_URL='$COMPOSE_BASE_URL/node/source.tar.gz'
NODE_PAIRING_TOKEN=YOUR_PAIRING_TOKEN
NODE_ID=my-node
NODE_DATA_DIR=./data
EOF
chmod 600 .env

docker compose up -d --build
```

The current compose template is self-contained:

- it does **not** need a local `Dockerfile.node`
- it uses an inline Dockerfile in the compose file itself
- during build, that inline Dockerfile downloads `/node/source.tar.gz`
- the source bundle includes the shared-package artifacts needed by the current runtime
- the pinned Node 24 image installs the minimal PTY runtime package with Linux build prerequisites; a failure is fatal to the Docker image build
- the remote machine does not need a full local Foxwarm checkout first

## Minimal troubleshooting

Check local status first:

```bash
docker compose ps
docker compose logs -f
```

Then check the master-side node state:

```text
/node
```

If approval succeeded but reconnect still fails, inspect or remove:

```text
./data/state/node_credentials.json
```
