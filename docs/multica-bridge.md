# Multica bridge (proof of concept)

`foxwarm-multica` is a local compatibility bridge that lets a Multica daemon launch a dedicated Foxwarm agent through Multica's existing Qwen custom-runtime protocol. It does not require changes to Multica.

This integration is intentionally limited to a trusted, same-host deployment in which the Multica daemon and Foxwarm can access the same task working directory.

## Requirements

- A running Foxwarm instance whose authenticated WebUI HTTP/SSE API is reachable from the Multica daemon host.
- A dedicated Foxwarm agent for Multica tasks.
- A Multica version whose Qwen runtime invokes `-p/--prompt`, `--output-format stream-json`, and optionally `--resume`, `--model`, and `--yolo`.
- Node.js with built-in `fetch` support.

## Install the local command

From a Foxwarm checkout:

```bash
npm install
npm link
foxwarm-multica --version
```

An installation from a local package path also exposes the bin:

```bash
npm install -g /path/to/foxwarm
foxwarm-multica --version
```

The bridge does not require compiled Foxwarm `lib/` output; it communicates with an already running Foxwarm server.

## Configure the daemon environment

Set these variables in the environment of the **Multica daemon process**:

```bash
export FOXWARM_MULTICA_BASE_URL='http://127.0.0.1:3000'
export FOXWARM_MULTICA_TOKEN='replace-with-the-foxwarm-instance-token'
export FOXWARM_MULTICA_AGENT='multica'
```

- `FOXWARM_MULTICA_BASE_URL` may include a deployment base path, but not embedded credentials, a query, or a fragment.
- `FOXWARM_MULTICA_TOKEN` is the existing Foxwarm instance token. This POC does not introduce narrower run credentials.
- `FOXWARM_MULTICA_AGENT` must name an existing dedicated Foxwarm agent. New Multica tasks create new sessions under this agent; Multica resume IDs map directly to existing Foxwarm session IDs under the same agent.
- `FOXWARM_MULTICA_REQUEST_TIMEOUT_MS` optionally changes the 30-second timeout used for individual REST requests. It does not impose a turn timeout; Multica owns process lifetime and cancellation.

Do not put the bearer token in a Multica runtime profile's fixed arguments.

## Register the Multica custom runtime

The current Multica command is:

```bash
multica runtime profile create \
  --display-name "Foxwarm" \
  --protocol-family qwen \
  --command-name foxwarm-multica
```

If the daemon service cannot find the linked command on its `PATH`, pin the absolute local executable for that profile:

```bash
command -v foxwarm-multica
multica runtime profile set-path <profile-id> --path /absolute/path/to/foxwarm-multica
```

Use the runtime profile returned by Multica for the workspace/agent configuration. Do not add fixed prompt, output-format, model, or resume arguments: Multica's Qwen adapter owns those arguments.

## Protocol behavior

For a new task, the bridge:

1. Creates a new Foxwarm session under `FOXWARM_MULTICA_AGENT`.
2. Sets the session working directory to the process working directory supplied by the Multica daemon.
3. Applies `--model` through Foxwarm's session model API when present.
4. Opens the Foxwarm per-session SSE stream and waits for its connection event before sending the task prompt.
5. Converts reliable Foxwarm stream snapshots and committed messages into Qwen JSONL thinking, text, tool-use, and tool-result events.
6. Waits for the Foxwarm turn to become idle or waiting, reads authoritative committed history, and emits exactly one Qwen result containing the Foxwarm session ID and accumulated turn usage.

`--resume <id>` skips creation, verifies that the existing session belongs to the configured bridge agent, rejects sessions with active or queued work, and continues that session.

Before sending the prompt, the bridge starts a narrow cancellation watchdog and passes only endpoint/session/token initialization over a private stdin pipe. A readiness handshake closes the initialization race. Normal completion explicitly disarms the watchdog; direct `SIGINT`/`SIGTERM` uses the same `/stop` path, while a hard parent-process kill closes the pipe and leaves the watchdog alive long enough to send `/stop`. The token is never placed in watchdog argv, environment, stdout, or logs.

Once prompt dispatch has been attempted, any bridge-side failure sends the same bounded best-effort stop before returning an error and disarming the watchdog. This includes a message POST whose response is lost after Foxwarm may have accepted it, an SSE disconnect, or a failure to fetch authoritative final history.

If a task-local `QWEN.md` exists in the working directory, the bridge reads it as runtime context before the task prompt. The file must be a regular non-symlink file no larger than 256 KiB. Its contents and the task prompt are sent only to Foxwarm and are never written to bridge diagnostics.

## Security and current limitations

- This is a trusted same-host/shared-workdir POC. Remote workspace synchronization and path translation are not implemented.
- The bridge uses Foxwarm's broad WebUI instance token. It does not provide scoped external-run credentials, cwd allowlists, or a production external-agent API.
- Multica injects its task token into the bridge process as `MULTICA_TOKEN`. The bridge deliberately ignores that variable and never copies it into the Foxwarm prompt, session history, tool environment, stdout, or diagnostics.
- Consequently, Foxwarm tools cannot call task-authenticated Multica CLI/API operations during this phase. Completion is reported through the bridge result only.
- Multica MCP configuration and other Qwen-only custom arguments are not supported. The bridge fails on unsupported options instead of silently claiming compatibility.
- Cancellation forwarding survives Multica's hard `exec.CommandContext` process kill. The resulting Foxwarm stop remains best effort while a tool call is already running, matching Foxwarm's current `/stop` behavior.
- Foxwarm WebUI SSE is used as the compatibility source. This POC does not declare it a stable third-party provider protocol.
- A dedicated agent and exclusive bridge ownership of its sessions are expected. Concurrent external writes to a resumed session can make turn attribution ambiguous.

The bridge writes only Qwen JSONL to stdout. Diagnostics are generic and do not include HTTP response bodies, the bearer token, or the task prompt.
