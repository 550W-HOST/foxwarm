# Unit: src-terminal-router

Files: src/terminalRouter.ts, src/terminalRouter.test.ts

## Purpose

Provides the terminal transport boundary used by WebUI and Code browser clients. It preserves master-local behavior while routing non-master terminal lifecycle/streams and trusted terminal Code-helper control requests to connected CLI nodes advertising `vscode-pty`.

## Key Exports

- `createTerminal(options)` — creates a local master PTY or a node-owned remote PTY according to `nodeId`
- `listTerminalRecords()` / `getTerminalRecord(id)` — merges/refetches local and connected remote terminal metadata
- `attachTerminalClient(id, ws)` / `detachTerminalClient(id, ws)` — attaches browser WebSocket clients and manages remote stream activation
- `writeTerminalInput(id, data)` / `resizeTerminal(id, cols, rows)` — forwards local calls or low-latency remote service commands
- `closeTerminal(id, reason)` — kills the selected local or remote PTY
- `resolveTerminalControlRequest(id, ws, payload)` — validates the pending control owner and returns browser acknowledgement to local or node-side helper IPC

## Behavior

- Remote lifecycle operations use correlated `vscode-pty` service requests; input, resize, and final detach use capability-checked fire-and-forget service commands.
- One remote attach is maintained per terminal at the node even when multiple browser WebSockets are attached at the master. The master fans each output event to all local clients.
- Code helper control is not broadcast with terminal output. Attachments opt in using `control=code`; the most recent capable client becomes owner. `code-request` receives trusted node identity at the router, one fixed `control/open` request is sent to that owner, and its matching result returns as `code-result` to the node.
- Both node and master keep capped recent-output buffers so detach/reattach receives backlog without recreating the PTY.
- Remote terminal records are rediscovered with `list` after master map loss. Metadata `get` refreshes node-side cwd tracking rather than returning a stale proxy record.
- Node disconnect sends an error and closes attached browser WebSockets but preserves the proxy record; if the CLI process reconnects with its in-memory PTY still alive, a later list/attach can rediscover it.
- Explicit close kills the node PTY. Browser page shutdown remains detach-only through the existing extension lifecycle policy.

## Dependencies

- `src/terminalManager.ts` — master-local PTY implementation
- `src/nodes/manager.ts` — version/capability-checked remote service request, command, and event transport
- `src/channels/webuiChannel.ts` — authenticated REST and WebSocket terminal routes consuming this abstraction

## Tests

- `src/terminalRouter.test.ts` registers a fake capable node and verifies remote create, attach/backlog, async output fanout, input/resize commands, detach, and close.

## Design Decisions

- [2026-07-14] Keep the browser REST/WebSocket terminal contract and master-local terminal manager unchanged at the boundary; add node routing behind the same API so Code and the main WebUI terminal do not need platform-specific transports.
