# Unit: Multica bridge CLI

Files: scripts/multicaBridge.js, scripts/multicaBridgeHttp.js, scripts/multicaBridgeWatchdog.js, scripts/multicaBridge.test.js
Secondary files: package.json, package-lock.json, docs/multica-bridge.md, README.md

## Purpose

Provides the installable `foxwarm-multica` local command. It adapts Multica's existing Qwen noninteractive JSONL protocol to Foxwarm's authenticated WebUI REST and per-session SSE surfaces without changing either server protocol.

The bridge is a proof of concept for trusted same-host execution. A Multica daemon starts the command in its prepared task directory; the bridge creates or resumes a session under one configured Foxwarm agent, maps cwd/model state, streams the turn, and returns the Foxwarm session ID as the Qwen resume ID.

## Key exports

- package `bin.foxwarm-multica` — installed command mapped to `scripts/multicaBridge.js`.
- `runBridge(argv, options?)` — complete invocation lifecycle with injectable streams, environment, fetch, and termination promise for tests.
- `parseArgs(argv)` — strict parser for the Multica-managed Qwen invocation.
- `loadConfig(env)` — validates the Foxwarm endpoint, bearer token, agent, and REST timeout.
- `readQwenContext(cwd)` / `composePrompt(prompt, context)` — bounded task-local `QWEN.md` context handling.
- `FoxwarmClient` — minimal authenticated REST/SSE client.
- `createTurnObserver(...)` — maps Foxwarm SSE snapshots and committed messages to Qwen-compatible JSONL events and detects turn completion.
- `startCancellationWatchdog(...)` — starts and handshakes a private-pipe child that forwards stop if the bridge parent is hard-killed.
- `summarizeTurn(history, baseline, model)` — derives one authoritative final text, model, and accumulated usage from post-baseline committed messages.

## Function index

| Function | File | Description |
|---|---|---|
| `parseArgs` | `multicaBridge.js` | Accepts prompt, stream-json, resume, model, help/version, and daemon-owned yolo arguments. |
| `loadConfig` | `multicaBridge.js` | Validates public runtime configuration without exposing secrets in errors. |
| `readQwenContext` | `multicaBridge.js` | Reads only a regular non-symlink `QWEN.md` up to 256 KiB. |
| `historyBaseline` / `messagesAfterBaseline` | `multicaBridge.js` | Isolates committed messages belonging to the current bridge turn. |
| `summarizeTurn` | `multicaBridge.js` | Selects final model text and sums Foxwarm usage metadata. |
| `runBridge` | `multicaBridge.js` | Creates/resumes, configures, subscribes before send, handles termination, and emits one result. |
| `startCancellationWatchdog` | `multicaBridge.js` | Handshakes and disarms the parent-death stop watchdog without putting credentials in argv or logs. |
| `FoxwarmClient.json` | `multicaBridgeHttp.js` | Performs bounded REST requests with generic redacted diagnostics. |
| `consumeSse` | `multicaBridgeHttp.js` | Parses Foxwarm SSE data frames and fails on malformed JSON. |
| `createTurnObserver` | `multicaBridgeHttp.js` | De-duplicates cumulative stream snapshots and maps messages/tool state to Qwen events. |

## Behavior

- New invocations create a fresh session under `FOXWARM_MULTICA_AGENT`; resume IDs are existing Foxwarm session IDs and must belong to that agent.
- The process cwd is written through Foxwarm's session cwd endpoint. An optional Multica model is written through the session model endpoint.
- The per-session SSE connection must acknowledge before the task message is posted, closing the subscribe/send race.
- Model stream snapshots are cumulative, so only appended text/thinking suffixes and previously unseen tool IDs are emitted. Committed messages fill reliable gaps and authoritative history owns the final result.
- Completion requires zero root-level queued items plus model/tool/error evidence; the committed user prompt alone cannot make an idle enqueue look terminal.
- `SIGINT`/`SIGTERM` issue `/stop` directly. A private-pipe child issues the same stop after hard parent death and is disarmed on normal completion.
- Any bridge failure after prompt dispatch has been attempted sends the same bounded best-effort stop before watchdog disarm, covering ambiguous POST acceptance, stream loss, and final-history failure.
- HTTP response bodies are never copied into diagnostics. The bridge does not log request bodies, prompt text, or credentials.

## Tests

`scripts/multicaBridge.test.js` uses a fake authenticated Foxwarm HTTP/SSE server to cover new and resumed sessions, subscription ordering, queued-user/idle completion races, root-queue resume rejection, cwd/model mapping, task-local context, streaming/tool conversion, final de-duplication and usage, malformed/error redaction, direct termination, and hard-kill watchdog stop forwarding.

## Design decisions

### D-multica-bridge-qwen-poc

[2026-07-30] The first Multica integration is an installable local CLI registered as a custom runtime under Multica's existing `qwen` protocol family. It uses current Foxwarm WebUI REST/SSE with the existing broad bearer token and is limited to a trusted same-host/shared-workdir deployment. It does not add a production external-agent API or modify Multica.

The bridge incorporates a bounded task-local `QWEN.md`, but deliberately does not propagate Multica's task token into Foxwarm prompt/history or tool execution. Task-authenticated Multica CLI operations from Foxwarm tools remain unsupported and explicit during this POC.

Turn completion follows Foxwarm's root queue state and requires model/tool/error evidence rather than treating the committed user prompt as completion. After prompt dispatch is attempted, a failed provider result must be preceded by a bounded best-effort stop so an ambiguously accepted turn cannot continue. Because Multica's Qwen adapter uses a hard `exec.CommandContext` kill, one narrow private-pipe watchdog survives parent death only to forward the current Foxwarm stop path; it is readiness-handshaken, normally disarmed, and never receives credentials through argv, environment, or logs.
