# Module: browser node

## Responsibility

The browser node is a Manifest V3 browser extension that connects as a standard Foxwarm node and exposes browser-tab tools backed by extension APIs. It owns extension-side pairing/authentication, tab/domain permission policy, tool confirmation, page injection, and popup configuration.

## Unit

- [browser-node-extension](../units/browser-node-extension.md) — manifest, service worker, tools, permission engine, storage, popup, and content helpers.

Connection protocol is shared with other nodes: [node communication](../threads/node-communication.md).

## Public tool surface

- `browser_list_tabs`
- `browser_get_tab_content`
- `browser_screenshot`
- `browser_click`
- `browser_execute_js`
- `browser_open_tab`
- `browser_close_tab`

These `browser_*` names are extension-advertised node tools. They are separate from the master/shared Puppeteer `browse_*` tool family; no alias translation currently unifies them.

## Permission boundary

- Resolution order: tab override, exact/parent domain rule, default (`ask`).
- `off` hides tabs and denies targeted operations.
- `ask` requires a user confirmation for each targeted operation.
- `auto` executes targeted operations without confirmation.
- `browser_open_tab` currently has no target tab and skips permission checking.
- `browser_execute_js` runs supplied JavaScript in the page's main world after permission succeeds.

## Invariants

- The extension advertises only its browser tools; it does not implement CLI file transfer, session RPC, or Code backend services.
- Pairing/auth credentials are stored in browser extension storage; the master still stores only the approved token hash.
- Restricted browser pages may reject scripting even when a tab policy allows it.
- Screenshots capture visible-tab PNG and may activate the target tab.

## Known limitation

The extension sends JSON `{type:"ping"}` and waits for JSON `pong`, while the current master heartbeat is WebSocket protocol ping/pong and has no JSON-ping handler. Browser WebSocket automatically answers the master's protocol ping, but that does not satisfy the extension's own JSON wait. This mismatch can cause periodic reconnects and remains open work.

## Design decisions

### D-browser-node-distinct-tools

Keep extension-native `browser_*` tools distinct from shared Puppeteer `browse_*` tools until a deliberate compatibility/API decision defines a unified contract.

### D-browser-node-tab-policy

Permission is explicit per tab/domain/default and enforced before targeted tool execution. Tool visibility and execution policy are extension-side user controls, not master filesystem isolation.

### D-browser-node-main-world-js

JavaScript execution is a high-trust tab operation in the page's main world and therefore follows the same per-call permission gate as other targeted mutations.
