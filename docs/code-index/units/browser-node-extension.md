# Unit: browser node extension

Files: packages/browser-node/manifest.json, packages/browser-node/README.md, packages/browser-node/background/main.js, packages/browser-node/background/websocket.js, packages/browser-node/background/tools.js, packages/browser-node/background/toolResults.js, packages/browser-node/background/permissions.js, packages/browser-node/background/storage.js, packages/browser-node/popup/popup.html, packages/browser-node/popup/popup.js, packages/browser-node/popup/popup.css, packages/browser-node/test/toolResults.test.mjs

## Purpose

Plain-ES-module Manifest V3 extension that pairs/authenticates to Foxwarm as a node, advertises browser-specific tools, applies tab/domain permissions, injects page operations, and exposes connection/permission/confirmation controls in the popup.

## File responsibilities

- `manifest.json` — tabs, scripting, storage, notifications, alarms, and all-URL host permissions.
- `background/websocket.js` — connection state, pairing/auth, credentials, reconnect, heartbeat, and tool-call responses.
- `background/tools.js` — seven tool definitions and implementations.
- `background/permissions.js` — tab/domain/default policy and pending confirmations.
- `background/storage.js` — browser-extension config, credentials, and permission persistence.
- `background/main.js` — service-worker wiring and popup message dispatch.
- `popup/*` — URL/token/name setup, status, tab policies, domain/default policy, and confirmation UI.

## Tools

| Tool | Current behavior |
|---|---|
| `browser_list_tabs` | Returns tabs whose resolved policy is not `off`; does not prompt for `ask` tabs |
| `browser_get_tab_content` | Accessibility-style interactive/landmark list, capped HTML, or capped body text |
| `browser_screenshot` | Activates target if needed and returns a visible-tab PNG in the current structured `inlineData` result; prior tab is not restored |
| `browser_click` | CSS-selector or viewport-coordinate click after scrolling selector target into view |
| `browser_execute_js` | Evaluates code in `world:'MAIN'` and returns JSON-cloned/stringified result |
| `browser_open_tab` | Creates a tab; currently skips permission resolution because no target tab exists |
| `browser_close_tab` | Removes an allowed target tab |

## Permission behavior

- Exact tab override wins, then exact hostname, then parent-domain rules, then default `ask`.
- Targeted `off` rejects before execution.
- Targeted `ask` creates a 60-second confirmation request, notification, and popup event.
- Notification close denies. Popup/notification actions resolve the pending request.
- `auto` proceeds immediately.

## Connection behavior

- Master URL is converted to `/node_ws` pairing or authenticated URL.
- Approved credentials are stored and cause a quick authenticated reconnect.
- Ordinary close schedules a 5-second reconnect unless manually disconnected or pairing was rejected.
- The extension handles pairing states, registration, `tool_call`, error, and an expected JSON `pong`.

## Limitations

- The current master does not answer the extension's JSON `ping`; see [browser node known limitation](../modules/browser-node.md#known-limitation).
- There are no automated tests or build step in this package.
- Host permission does not make browser-internal/restricted pages scriptable.
- The extension exposes no node file transfer, session RPC, or backend service messages.

## Canonical ownership

- Extension tab/domain/default permission boundary: [D-browser-node-tab-policy](../modules/browser-node.md#d-browser-node-tab-policy).
- Distinct extension `browser_*` tool names: [D-browser-node-distinct-tools](../modules/browser-node.md#d-browser-node-distinct-tools).
- Main-world JavaScript risk boundary: [D-browser-node-main-world-js](../modules/browser-node.md#d-browser-node-main-world-js).
- Structured current screenshot writing and the separately deletable old-node reader: [D-node-thread-tool-result-compatibility](../threads/node-communication.md#d-node-thread-tool-result-compatibility).
