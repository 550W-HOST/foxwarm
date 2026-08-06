# Unit: webui-terminal

Files: packages/webui/src/components/TerminalView.tsx, packages/webui/src/terminalTarget.ts

## Purpose

Renders an interactive terminal session in the browser using xterm.js, connecting to a cwd-based backend terminal via WebSocket. It handles terminal creation/reuse, input/output streaming, resize events, and lifecycle management.

## Key Exports

- `default` (TerminalView) — React component for embedding a live terminal session

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `TerminalView(props)` | ~35–300 | Main component managing terminal lifecycle, WebSocket connection, and UI rendering |
| `useEffect` (xterm setup) | ~75–150 | Initializes xterm.js Terminal instance, FitAddon, ResizeObserver, delayed/font-ready fit passes, and resize notification helper |
| `useEffect` (terminal connection) | ~117–210 | Creates or reuses a terminal via REST API, establishes WebSocket stream |
| `start()` | ~125–205 | Async helper that resolves terminal ID (lookup/list/create) and wires up WebSocket handlers |
| `requestedTarget` (useMemo) | ~52–57 | Normalizes the initial node and cwd into one terminal identity |
| `findTerminalForTarget(...)` | terminalTarget.ts | Finds only an exact normalized node/cwd match for reuse |

## Dependencies

- `../config` — `API_BASE_PATH`, `makeWebSocketUrl` (server endpoint configuration)

## Behavior

- On mount, creates an xterm.js Terminal with a FitAddon and attaches a ResizeObserver to auto-fit and send resize messages over WebSocket. Initial/font-ready/window resize fit passes are repeated so the PTY dimensions converge after fonts and pane layout settle.
- On mount, resolves a terminal ID by: checking an explicit `initialTerminalId`, listing existing terminals for exact normalized node-and-cwd reuse, or creating a new one via POST with the requested `nodeId`, `cwd`, `cols`, and `rows`. It never substitutes `master` for a valid requested remote node.
- Opens a WebSocket to `/terminals/stream`, forwarding user keystrokes and xterm binary-input events as `input` messages and writing received `output` data to xterm.
- Handles `ready` (with backlog replay), `output`, `exit`, and `error` WebSocket message types, updating component status accordingly.
- During `ready` backlog replay, temporarily suppresses xterm-generated `onData` forwarding so stale terminal query responses from replayed output are not injected into the live PTY; live output after readiness still forwards terminal emulator responses normally.
- Invokes callbacks (`onTerminalReady`, `onTerminalClosed`, `onSessionsChanged`) at appropriate lifecycle points.
- Cleans up WebSocket, xterm instance, and ResizeObserver on unmount or session change.

## Integration

- Communicates with the backend terminal service via REST (`/terminals` CRUD) and WebSocket (`/terminals/stream`).
- Accepts callbacks from a parent component to signal terminal readiness, closure, and session list changes.
- No longer provides a workspace opener button; terminal stays independent after the WebUI workspace feature removal.
- Designed to be embedded in the WebUI workbench shell; chat/session context may provide an initial node and cwd, but backend terminal creation no longer receives or stores a session id.

## Design Decisions

- [2026-07-09] WebUI terminal callers were updated to stop passing/depending on `sessionId`; persisted legacy terminal tab fields such as `contextSessionId` are tolerated as extra stored data but are ignored by current terminal logic.