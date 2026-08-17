# Unit: webui-terminal

Files: packages/webui/src/components/TerminalView.tsx, packages/webui/src/components/TerminalVirtualKeyboard.tsx, packages/webui/src/components/TerminalVirtualKeyboard.css, packages/webui/src/terminalVirtualKeyboard.ts, packages/webui/src/terminalTarget.ts

## Purpose

Renders an interactive terminal session in the browser using xterm.js, connecting to a cwd-based backend terminal via WebSocket. It handles terminal creation/reuse, input/output streaming, resize events, lifecycle management, and the mobile-first Web/native/collapsed keyboard surface.

## Key Exports

- `default` (TerminalView) — React component for embedding a live terminal session
- `default` (TerminalVirtualKeyboard) — complete US-ASCII virtual keyboard bound to a public xterm input surface
- `encodeTerminalVirtualKey(...)` — pure VT sequence encoder for printable, editing, navigation, and F1-F12 keys
- `loadTerminalKeyboardMode(...)` — resolves persisted or pointer-aware default keyboard mode

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `TerminalView(props)` | ~35–300 | Main component managing terminal lifecycle, WebSocket connection, and UI rendering |
| `useEffect` (xterm setup) | ~75–150 | Initializes xterm.js Terminal instance, FitAddon, ResizeObserver, delayed/font-ready fit passes, and resize notification helper |
| `useEffect` (terminal connection) | ~117–210 | Creates or reuses a terminal via REST API, establishes WebSocket stream |
| `start()` | ~125–205 | Async helper that resolves terminal ID (lookup/list/create) and wires up WebSocket handlers |
| `requestedTarget` (useMemo) | ~52–57 | Normalizes the initial node and cwd into one terminal identity |
| `findTerminalForTarget(...)` | terminalTarget.ts | Finds only an exact normalized node/cwd match for reuse |
| `TerminalVirtualKeyboard(props)` | TerminalVirtualKeyboard.tsx | Renders fixed special keys and stable-height ABC/123/More pages with integrated mode controls |
| `TerminalKeyboardHeaderControl(props)` | TerminalVirtualKeyboard.tsx | Provides pane-local Web-keyboard re-entry while Native or Collapsed mode hides the body |
| `emitKey(...)` | TerminalVirtualKeyboard.tsx | Encodes a key against current public xterm modes and calls `term.input(..., true)` |
| `onPointerDown(...)` / `onPointerUp(...)` | TerminalVirtualKeyboard.tsx | Implements release-to-send, pointer cancellation, and bounded repeat gestures |
| `changeMode(...)` | TerminalVirtualKeyboard.tsx | Persists Web/native/collapsed mode and synchronously configures the xterm textarea |
| `encodeTerminalVirtualKey(...)` | terminalVirtualKeyboard.ts | Encodes printable/control/Alt and mode-aware VT special-key sequences |
| `nextShiftState(...)` | terminalVirtualKeyboard.ts | Applies one-shot, quick-double-tap lock, and unlock Shift transitions |

## Dependencies

- `../config` — `API_BASE_PATH`, `makeWebSocketUrl` (server endpoint configuration)
- `@xterm/xterm` public `input`, `paste`, `textarea`, `modes`, selection, focus, and blur APIs

## Behavior

- On mount, creates an xterm.js Terminal with a FitAddon and attaches a ResizeObserver to auto-fit and send resize messages over WebSocket. Initial/font-ready/window resize fit passes are repeated so the PTY dimensions converge after fonts and pane layout settle.
- On mount, resolves a terminal ID by: checking an explicit `initialTerminalId`, listing existing terminals for exact normalized node-and-cwd reuse, or creating a new one via POST with the requested `nodeId`, `cwd`, `cols`, and `rows`. It never substitutes `master` for a valid requested remote node.
- Opens a WebSocket to `/terminals/stream`, forwarding user keystrokes and xterm binary-input events as `input` messages and writing received `output` data to xterm.
- Keeps xterm `onData` as the only terminal-input-to-WebSocket route. Virtual keys call public `term.input(encoded, true)` and paste calls public `term.paste(text)`; the keyboard does not call backend APIs or xterm private members.
- Uses the browser WebSocket implementation, which automatically answers the server's protocol-level keepalive pings; no application-level ping/pong message handling is needed.
- Handles `ready` (with backlog replay), `output`, `exit`, and `error` WebSocket message types, updating component status accordingly.
- During `ready` backlog replay, temporarily suppresses xterm-generated `onData` forwarding so stale terminal query responses from replayed output are not injected into the live PTY; live output after readiness still forwards terminal emulator responses normally.
- Invokes callbacks (`onTerminalReady`, `onTerminalClosed`, `onSessionsChanged`) at appropriate lifecycle points.
- Cleans up WebSocket, xterm instance, and ResizeObserver on unmount or session change.
- On coarse-pointer devices with no saved preference, defaults to the Web keyboard; on fine-pointer desktops, defaults collapsed so the physical keyboard remains normal. The explicit Web/native/collapsed choice is browser-local and persists under `foxwarm.terminalKeyboard.mode`.
- Web mode makes xterm's textarea read-only with `inputmode=none` so tapping the terminal does not summon the mobile IME or native form accessory bar. Native mode restores the textarea and focuses it synchronously from the integrated bottom-row control. Native and Collapsed modes hide the keyboard body and expose one compact keyboard icon in the existing terminal header; on fine-pointer desktops, Collapsed mode leaves the textarea's normal input behavior intact.
- The fixed special bar contains Esc, Tab, one-shot Ctrl/Alt, arrows, and More. ABC and 123 pages use four familiar phone-keyboard rows; their bottom row is page switch, Native, Space, Collapse, Enter. Shift is one-shot or double-tap locked and changes visible labels. More replaces the body at the same height with three rows containing Home/End/PgUp/PgDn, Insert/Delete, Copy/Paste, and F1-F12 plus the same bottom controls, whose page key returns to More's source page.
- Pointer keys send only on valid release. Backspace, Delete, arrows, and PgUp/PgDn instead begin after a 350 ms hold and repeat every 60 ms, with one-shot modifiers retained for the gesture and consumed only when it ends. Drag-out, pointer cancellation, lost capture, reset, and unmount stop the gesture without a release send.
- Copy writes the current nonempty xterm selection and gives concise inline feedback when unavailable; paste reads the Clipboard API and uses `term.paste` without consuming modifiers. No textarea fallback is created.
- The keyboard is a flex child of the terminal pane, so its fixed body and integrated safe-area bottom row naturally participate in ResizeObserver/FitAddon refits. In Native mode, the header re-entry control compares its stable, untransformed anchor bottom with the `visualViewport` visible bottom and moves only by their local overlap; visual-viewport, window, and anchor resizes recompute it so split panes do not inherit a global full-keyboard translation.
- The keyboard's visual hierarchy is neutral and iOS-inspired rather than literal: warm-gray wells, light character keys, darker utility/modifier/page keys, restrained radius/shadow/spacing, neutral pressed and modifier states, and charcoal/gray dark-mode equivalents. Terminal keyboard controls do not use blue accents.

## Integration

- Communicates with the backend terminal service via REST (`/terminals` CRUD) and WebSocket (`/terminals/stream`).
- Accepts callbacks from a parent component to signal terminal readiness, closure, and session list changes.
- No longer provides a workspace opener button; terminal stays independent after the WebUI workspace feature removal.
- Designed to be embedded in the WebUI workbench shell; chat/session context may provide an initial node and cwd, but backend terminal creation no longer receives or stores a session id.

## Design Decisions

- [2026-07-09] WebUI terminal callers were updated to stop passing/depending on `sessionId`; persisted legacy terminal tab fields such as `contextSessionId` are tolerated as extra stored data but are ignored by current terminal logic.
- <a id="d-webui-terminal-mobile-virtual-keyboard"></a> **[2026-08-17] Mobile terminal input uses a complete WebUI-rendered US-ASCII keyboard rather than a special-key-only bar.** Its immutable contract is a fixed Esc/Tab/Ctrl/Alt/arrows/More bar with no Shift; exactly three stable-height ABC, 123, and More bodies; one-shot Ctrl/Alt and one-shot-or-double-lock Shift; and release-to-send with bounded repeat only for Backspace/Delete/arrows/PgUp/PgDn. ABC/123 integrate page switch, Native, Space, Collapse, and Enter in the safe-area bottom row; More uses three content rows plus the same controls and returns to its source page. There is no separate footer. Native/Collapsed re-entry is one compact, pane-local keyboard icon in the terminal header. The keyboard follows a neutral iOS-inspired hierarchy with light character keys, darker utility keys, neutral dark-mode equivalents, and no blue accents. Web mode suppresses the native mobile textarea keyboard without `disableStdin`; Native restores and synchronously focuses it. Virtual input must stay on supported xterm public APIs and the existing `onData` WebSocket pipeline, with pure tested VT encoding and no private xterm members, new backend protocol, configurable layouts, macros, extra pages, CJK Web keyboard, haptics, gestures, or Kitty protocol in V1.