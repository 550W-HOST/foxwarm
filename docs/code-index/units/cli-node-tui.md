# Unit: cli-node-tui

Files: packages/cli-node/src/tui.ts

## Purpose

Provides an interactive terminal UI (TUI) for the Foxwarm CLI node client, allowing operators to view bound sessions, browse message history, approve/reject tool calls, and send messages to sessions — all rendered in the terminal using Ink (React for CLI).

## Key Exports

This file is a standalone executable entry point (`#!/usr/bin/env node`) and does not export any symbols. It renders the TUI directly on import.

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|----------------|--------------------------|
| `parseArgs()` | ~30–60 | Parses CLI arguments into an `Opts` object with validation |
| `messageText(message)` | ~63–66 | Truncates a history message's text to 500 chars |
| `toolPreview(tool, args)` | ~68–72 | Formats a tool call name and JSON args for display |
| `App({ opts })` | ~74–170 | Main React/Ink component managing state, client lifecycle, input handling, and rendering |
| `refresh()` (inside App) | ~86–102 | Fetches sessions and history from the client and updates state |
| `useEffect` (client setup) | ~104–135 | Initializes NodeClient, connects, sets up polling and cleanup |
| `useInput` handler | ~139–163 | Handles keyboard input for navigation, approval, drafting, and sending |

## Dependencies

- `./client` — imports `NodeClient`, `CliNodeHistoryMessage`, `CliNodeSessionSummary`

## Behavior

- On startup, parses CLI args, instantiates a `NodeClient` with a `toolCallInterceptor` callback, starts the local trigger server, and connects to the master host.
- Polls `refresh()` every 3 seconds to update session list and message history.
- Tool call approval flow: if not auto-approved (by `--auto-approve-all` or regex match), presents an interactive prompt; supports timeout-based auto-rejection derived from server timeout or `--timeout` flag.
- Keyboard-driven: arrow keys select sessions, Enter sends drafted text, Y/N approve/reject tool calls, Ctrl+R forces refresh, Q/Ctrl+C exits.
- Sets `FOXWARM_NO_CONSOLE_LOG` env var to suppress library console output that would corrupt the TUI.

## Integration

- Wraps `NodeClient` from `./client` as the communication layer to the Foxwarm master server.
- Consumes `CliNodeSessionSummary` and `CliNodeHistoryMessage` types for rendering session and history data.
- Acts as the operator-facing interface for nodes that require human-in-the-loop tool call approval.