# Unit: src-terminal-manager

Files: src/terminalManager.ts

## Purpose

Manages master-local pseudo-terminal (PTY) processes, including cwd-based creation, input/output streaming, resize/cwd tracking, cleanup, and terminal-scoped Code-helper control requests.

## Key Exports

- `TerminalRecord` — type representing the serializable metadata of a terminal instance
- `createTerminal(options)` — spawns a new PTY terminal for a requested cwd/node
- `getTerminal(terminalId)` — synchronous lookup of terminal metadata
- `getTerminalRecord(terminalId)` — async lookup that refreshes tracked cwd
- `listTerminalRecords()` — lists active terminals
- `attachTerminalClient(terminalId, client)` — registers a WebSocket client and returns backlog
- `detachTerminalClient(terminalId, client)` — unregisters a WebSocket client
- `writeTerminalInput(terminalId, data)` — sends input to the PTY process
- `resizeTerminal(terminalId, cols, rows)` — resizes the PTY
- `closeTerminal(terminalId, reason)` — kills the PTY and cleans up resources
- `resolveTerminalControlRequest(terminalId, client, payload)` — accepts an acknowledgement only from the Code-control client that owns the pending helper request

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `ensureNodePtyDarwinSpawnHelperExecutable()` | ~37–52 | Ensures macOS spawn-helper has executable permission |
| `getShellPath()` | ~54–58 | Returns user's shell or falls back to /bin/bash |
| `sanitizeTerminalRecord(record)` | ~60–73 | Strips internal fields to produce a public TerminalRecord |
| `buildRcFile(terminalId)` | ~75–95 | Writes a temporary bashrc that tracks cwd via PROMPT_COMMAND |
| `readTrackedCwd(cwdPath)` | ~97–105 | Reads the cwd tracking file written by the shell hook |
| `refreshTerminalCwd(record)` | ~107–112 | Updates a terminal record's cwd from the tracking file |
| `cleanupTerminal(record)` | ~114–131 | Removes terminal from map, closes clients, deletes temp files |
| `createTerminal(options)` | ~133–210 | Spawns a PTY process, wires output/exit handlers, returns record |
| `getTerminal(terminalId)` | ~212–215 | Synchronous terminal lookup |
| `getTerminalRecord(terminalId)` | ~217–224 | Async terminal lookup with cwd refresh |
| `listTerminalRecords(options)` | ~226–234 | Lists and sorts terminals with cwd refresh |
| `attachTerminalClient(terminalId, client)` | ~236–247 | Adds WebSocket client, returns backlog buffer |
| `detachTerminalClient(terminalId, client)` | ~249–255 | Removes WebSocket client from terminal |
| `writeTerminalInput(terminalId, data)` | ~257–263 | Forwards user input to PTY |
| `resizeTerminal(terminalId, cols, rows)` | ~265–276 | Resizes PTY with safe minimum bounds |
| `closeTerminal(terminalId, reason)` | ~278–293 | Kills PTY process and runs cleanup |

## Dependencies

- `./config` — `STATE_DIR` for terminal temp files
- `./common` — `logger` for structured logging
- `./sessionManager` — `getSession` to resolve session metadata (agent, cwd, currentNode)

## Behavior

- Maintains an in-memory `Map<string, ManagedTerminal>` as the source of truth for active terminals.
- Each terminal spawns a `node-pty` process in the requested cwd with a custom bashrc that writes the shell's cwd to a temp file on every prompt, enabling async cwd tracking.
- Each terminal receives a generated `code` helper PATH plus local IPC socket/capability. Helper open/add requests are sent only to the most recently attached WebSocket that explicitly declared `control=code`; ordinary WebUI terminal clients never become control owners.
- Output is buffered (capped at 200KB) so newly attached WebSocket clients receive recent history.
- On PTY exit, all attached clients receive an exit message, then temp files (rcfile, cwd file) are cleaned up.
- On macOS, proactively fixes the node-pty spawn-helper executable bit if missing.

## Integration

- `src/terminalRouter.ts` consumes this API for `nodeId=master` and provides the matching remote-node implementation. WebUI REST/WebSocket routes consume the router rather than calling this module directly.
- Uses `STATE_DIR/.temp/terminals` for temporary shell config and cwd tracking files, avoiding chat-session/agent binding.

## Design Decisions

- [2026-07-09] Terminal backend sessions must not bind to Foxwarm chat sessions. Terminal creation is cwd-based (`cwd`, plus optional `nodeId`, `cols`, `rows`), and close semantics are kill-the-backend-PTY.
- [2026-07-14] The terminal helper uses terminal-scoped local IPC and a single most-recent Code-capable control owner. It must not broadcast open requests to multiple restored browser terminals or treat ordinary main-WebUI terminal clients as Code owners.