# Unit: src-channels-tui

Files: src/channels/tuiChannel.ts

## Purpose

Implements a terminal-based user interface (TUI) channel using the `blessed` library, providing a split-view with logs and chat tabs. Users can browse sessions, view chat history, and send messages through an interactive terminal UI.

## Key Exports

- `TUIChannel` — Class implementing the `Channel` interface for terminal-based interaction

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `constructor()` | ~35–155 | Creates blessed screen, logs, chat, session list, input, and status bar widgets |
| `setupEventHandlers()` | ~157–210 | Binds keyboard/mouse events for navigation, input submission, and tab switching |
| `switchTab()` | ~212–230 | Toggles between logs and chat views |
| `refreshSessionList()` | ~232–270 | Populates session list widget from sessionManager state |
| `enterChat(sessionId)` | ~272–280 | Activates chat mode for a selected session |
| `exitChat()` | ~282–290 | Deactivates chat mode and returns to session list |
| `loadChatHistory(sessionId)` | ~292–320 | Loads and displays message history for a session |
| `updateSessionPreview()` | ~322–350 | Shows a read-only preview of the selected session's recent messages |
| `sendChatMessage(text)` | ~352–400 | Processes user input, handles commands, binds sessions, and dispatches messages |
| `showExitConfirmation()` | ~402–440 | Displays a confirmation dialog before quitting |
| `fullRedraw()` | ~442–460 | Forces a complete screen redraw to fix rendering artifacts |
| `updateProcessingStatus()` | ~462–490 | Polls session busy state and updates status bar/label accordingly |
| `displayMessage(role, text)` | ~492–502 | Formats and appends a message to the chat log widget |
| `logToTUI(level, message)` | ~504–512 | Appends a log entry with color coding to the logs widget |
| `start()` | ~514–530 | Initializes the TUI, shows welcome text, starts status polling interval |
| `stop()` | ~532–538 | Clears the polling interval and destroys the screen |
| `onMessage(handler)` | ~540–542 | Registers the message handler callback |
| `onCommand(handler)` | ~544–546 | Registers the command handler callback |
| `sendMessage(userId, messageText, options?)` | ~548–550 | No-op; messages displayed via displayMessage instead |
| `getScreen()` | ~556–558 | Returns the blessed screen instance |

## Dependencies

- `../channel` — `Channel`, `ChannelContext`, `ChannelMessage` interfaces
- `../common` — `logger`
- `../sessionManager` — Main-owned channel binding and pre-runtime catalog fallback
- `../sessionRuntime` — placement-neutral session list, history, and status projections

## Behavior

- Maintains two UI tabs: a scrollable log viewer and a chat interface with session list, message log, and text input.
- On first message to a session, automatically binds the TUI channel to that session via `sessionManager.bindSession`.
- If no session exists for the selected ID, creates one via `sessionManager.createSession`.
- Handles `/`-prefixed commands by delegating to the registered command handler.
- Displays non-command replies directly; it no longer carries a special filter for busy queue acknowledgements because the router now enqueues busy messages silently.
- Polls the SessionRuntime projection every 500ms to update a processing indicator in the status bar and chat label without hydrating Worker-owned state in Main.
- Ensures UTF-8 cleanliness by round-tripping text through `Buffer`.
- Shows an exit confirmation dialog to prevent accidental quit.

## Integration

- Implements the `Channel` interface, making it interchangeable with other channel implementations (e.g., Discord, CLI).
- Uses SessionRuntime for list/history/status reads and `sessionManager` only for Main-owned channel binding/catalog fallback during startup; it does not maintain its own persistence or hydrate Worker-owned authority.
- Exposes `logToTUI` for external code to route log output into the TUI logs panel.
- Exposes `getScreen()` so other components can interact with the blessed screen if needed.
- Message and command handlers are injected by the application bootstrap layer via `onMessage`/`onCommand`.