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

## Configure and register a target

First authenticate the Multica CLI and select the workspace that should own the runtime profile:

```bash
multica login
multica workspace switch <id-or-slug>
```

For a named Multica CLI/daemon profile, use that profile consistently:

```bash
multica --profile team-a login
multica --profile team-a workspace switch <id-or-slug>
foxwarm-multica setup --multica-profile team-a # plus Foxwarm target/token options
```

Then run the setup command. The Foxwarm token must come from a file or the environment; it is intentionally not accepted as an argv option.

```bash
foxwarm-multica setup \
  --url http://127.0.0.1:3001 \
  --agent multica \
  --token-file ~/.config/foxwarm/multica-token
```

The dedicated agent must already exist. Add `--create-agent` to create it explicitly when missing. Setup validates the Foxwarm API/token and current Multica workspace before any agent creation.

Setup creates one private target directory under `~/.local/share/foxwarm-multica/<instance>/` by default:

- `config.json` (`0600`, owned by the setup user) stores the copied token, endpoint, agent, selected Multica CLI profile, and recorded runtime profile ID.
- `foxwarm-multica-<instance>` (`0700`) is a target-specific launcher. It contains only paths, never the token.

The command creates or reuses a workspace custom runtime profile with protocol family `qwen`, then pins that profile to the local launcher with `multica runtime profile set-path`. Reruns reuse the recorded profile ID when valid, fall back to the deterministic target launcher name, refresh the private config/path, and do not create duplicate profiles.

For multiple Foxwarm targets on one Multica daemon, give each a distinct local instance and display name:

```bash
FOXWARM_MULTICA_TOKEN="$(cat ~/.config/foxwarm/staging-token)" \
  foxwarm-multica setup --instance staging --display-name "Foxwarm Staging" \
  --url https://staging.example.test --agent multica_staging

foxwarm-multica setup --instance production --display-name "Foxwarm Production" \
  --url https://foxwarm.example.test --agent multica_production \
  --token-file ~/.config/foxwarm/production-token
```

Each generated runtime carries its target through the private config/launcher. The launcher clears daemon-global Foxwarm target variables, and the private config is authoritative, so multiple targets cannot accidentally inherit one daemon-wide token or endpoint.

Useful setup options:

- `--multica <command-or-path>` selects the already-authenticated Multica executable.
- `--multica-profile <name>` selects a named Multica CLI/daemon profile. Setup applies the same `--profile <name>` to profile list/create/update/path-pin operations and to the printed daemon start/restart commands. An omitted or explicitly empty value uses the default Multica profile.
- `--install-root <path>` changes the private local setup root.
- `--dry-run` validates Foxwarm and lists the current Multica profiles without creating agents, files, profiles, or path overrides.
- `--help` shows all defaults and options.

Setup never logs in, selects a workspace, or restarts the daemon. On success it prints the exact `multica [--profile <name>] daemon restart` command and the alternative start command for the same profile. Existing running tasks are not disrupted automatically.

The generated launcher preserves the existing Qwen invocation unchanged. Do not add fixed prompt, output-format, model, resume, or token arguments to the profile.

For Docker, the daemon container must be able to execute the pinned launcher and read its private config/bridge paths. Multica and Foxwarm must also see task workspaces at compatible paths; mount the launcher/config/bridge and workspace directories accordingly.

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
