# Unit: webui-terminal

Files: packages/webui/src/components/TerminalView.tsx, packages/webui/src/components/TerminalVirtualKeyboard.tsx, packages/webui/src/components/TerminalVirtualKeyboard.css, packages/webui/src/terminalVirtualKeyboard.ts, packages/webui/src/terminalPinchZoom.ts, packages/webui/src/terminalTarget.ts

## Purpose

Renders an interactive terminal session in the browser using xterm.js, connecting to a cwd-based backend terminal via WebSocket. It handles terminal creation/reuse, input/output streaming, resize events, lifecycle management, and the mobile-first Web/native/collapsed keyboard surface.

## Key Exports

- `default` (TerminalView) — React component for embedding a live terminal session
- `default` (TerminalVirtualKeyboard) — complete US-ASCII virtual keyboard bound to a public xterm input surface
- `encodeTerminalVirtualKey(...)` — pure VT sequence encoder for printable, editing, navigation, and F1-F12 keys
- `loadTerminalKeyboardMode(...)` — resolves persisted or pointer-aware default keyboard mode
- `terminalPinchFontSize(...)` — calculates baseline-relative, clamped mobile pinch font size
- `attachTerminalPinchZoom(...)` — installs and cleans up coalesced two-touch xterm zoom handling
- `loadTerminalFontSize(...)` / `persistTerminalFontSize(...)` — read and write the one global browser-local terminal font preference
- `terminalFontSizeShortcutDelta(...)` — recognizes desktop Ctrl plus physical Minus/Equal font steps

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
| `clampTerminalFontSize(...)` / `loadTerminalFontSize(...)` / `persistTerminalFontSize(...)` | terminalPinchZoom.ts | Owns the rounded 5–24px global localStorage preference boundary |
| `terminalPinchDistance(...)` / `terminalPinchFontSize(...)` | terminalPinchZoom.ts | Measures two touches and derives a rounded 5–24px size from the gesture baseline |
| `attachTerminalPinchZoom(...)` | terminalPinchZoom.ts | Handles standard two-touch events, coalesced option updates/refits, cancellation, and cleanup |
| `terminalFontSizeShortcutDelta(...)` | terminalPinchZoom.ts | Maps Ctrl plus physical Minus/Equal keydown events to one-pixel steps |

## Dependencies

- `../config` — `API_BASE_PATH`, `makeWebSocketUrl` (server endpoint configuration)
- `@xterm/xterm` public `input`, `paste`, `textarea`, `modes`, `options.fontSize`, selection, focus, and blur APIs

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
- Each newly created browser Terminal loads one global browser-local font preference from `foxwarm.terminal.fontSize`; absent or invalid data falls back to 14px, finite values are rounded to 0.5px and clamped to 5–24px. Pinch and desktop shortcut changes update the active Terminal and this one localStorage key. Already-mounted sibling terminals intentionally keep their current size until recreated; there is no same-window synchronization event or per-terminal/node/tab preference.
- Two-touch pinch gestures attached only to the xterm host scale from the gesture's starting distance and font size, round to 0.5px steps, and clamp to 5–24px. Effective changes persist, write public `term.options.fontSize`, then use the existing FitAddon/PTY resize notifier at most once per animation frame. One-touch events are untouched; an active pinch prevents browser defaults and stops propagation before xterm's document-level touch gesture handling, including its terminating event, so pinch translation cannot scroll/select or leave stale tap state. Touch-count changes, cancellation, remount, and unmount clear pending work.
- While xterm owns a physical keydown, Ctrl plus physical Minus decreases the active terminal by 1px and Ctrl plus physical Equal increases it by 1px. These events prevent browser zoom and return false from xterm's public custom-key handler so no keystroke/control byte reaches the PTY. Effective changes persist and use the normal fit/resize path; min/max repeats remain consumed but perform no redundant option write, refit, storage write, or synchronization.

## Integration

- Communicates with the backend terminal service via REST (`/terminals` CRUD) and WebSocket (`/terminals/stream`).
- Accepts callbacks from a parent component to signal terminal readiness, closure, and session list changes.
- No longer provides a workspace opener button; terminal stays independent after the WebUI workspace feature removal.
- Designed to be embedded in the WebUI workbench shell; chat/session context may provide an initial node and cwd, but backend terminal creation no longer receives or stores a session id.

## Design Decisions

- [2026-07-09] WebUI terminal callers were updated to stop passing/depending on `sessionId`; persisted legacy terminal tab fields such as `contextSessionId` are tolerated as extra stored data but are ignored by current terminal logic.
- <a id="d-webui-terminal-mobile-virtual-keyboard"></a> **[2026-08-18] Mobile terminal input uses a complete WebUI-rendered US-ASCII keyboard rather than a special-key-only bar.** Its immutable contract is a fixed Esc/Tab/Ctrl/Alt/`← ↓ ↑ →`/More bar with no Shift; exactly three stable-height ABC, 123, and More bodies; one-shot Ctrl/Alt and one-shot-or-double-lock Shift; and release-to-send with bounded repeat only for Backspace/Delete/arrows/PgUp/PgDn. ABC/123 integrate page switch, Native, Space, Collapse, and Enter in the safe-area bottom row; More uses three content rows plus the same controls and returns to its source page. There is no separate footer. Native/Collapsed re-entry is one compact, pane-local keyboard icon in the terminal header. The neutral iOS-inspired hierarchy uses enlarged QWERTY labels and Backspace icon, slightly roomier row spacing with minimal non-safe-area bottom padding, extra Shift/Z and M/Backspace separation, a roughly 1.5x-wider Enter balanced by a narrower Space, darker utility keys, neutral dark-mode equivalents, and no blue accents. Web mode suppresses the native mobile textarea keyboard without `disableStdin`; Native restores and synchronously focuses it. Virtual input must stay on supported xterm public APIs and the existing `onData` WebSocket pipeline, with pure tested VT encoding and no private xterm members, new backend protocol, configurable layouts, macros, extra pages, CJK Web keyboard, haptics, gestures, or Kitty protocol in V1.
- <a id="d-webui-terminal-mobile-pinch"></a> **[2026-08-18] Terminal font size uses one global browser-local preference shared by mobile pinch and desktop Ctrl shortcuts.** Each newly created Terminal loads `foxwarm.terminal.fontSize`, with 14px as the absent/invalid fallback and a rounded 5–24px range. Changes affect only the active mounted Terminal and update that one localStorage key; already-open sibling terminals intentionally do not synchronize and will load the preference only when recreated. Mobile zoom uses standard two-touch events and public xterm `options.fontSize`, derives every update from the gesture's starting distance and font size to avoid cumulative drift, and coalesces changes before the existing FitAddon and PTY resize path. One-finger terminal scroll/selection and virtual-keyboard gestures remain unchanged; active-pinch events and their terminator are contained before xterm's document gesture handling. While xterm owns the keyboard event, Ctrl plus physical Minus/Equal applies a 1px decrement/increment, prevents browser zoom, and suppresses PTY input. Bounds consume the shortcut without redundant writes, refits, or persistence. There is no backend/session state, per-terminal preference, visible control, Ctrl+0, or Meta shortcut.