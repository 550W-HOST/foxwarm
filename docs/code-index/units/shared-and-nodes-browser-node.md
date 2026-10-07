# Unit: Browser extension Node

Files: `packages/browser-node/background/main.js`, `packages/browser-node/background/nodeProtocol.js`, `packages/browser-node/background/permissions.js`, `packages/browser-node/background/storage.js`, `packages/browser-node/background/toolResults.js`, `packages/browser-node/background/tools.js`, `packages/browser-node/background/websocket.js`, `packages/browser-node/manifest.json`, `packages/browser-node/popup/popup.js`, `packages/browser-node/popup/popup.html`, `packages/browser-node/popup/popup.css`, `packages/browser-node/test/nodeProtocol.test.mjs`, `packages/browser-node/test/toolResults.test.mjs`

## Purpose

Provides the browser-extension Node transport: WebSocket lifecycle, shared protocol adaptation, per-tab/domain permission checks, extension storage, browser tools, tool-result delivery, and popup controls.

## Stable symbols and callers

`background/main.js` and `background/websocket.js` own extension startup/transport; `permissions.js` owns tab/domain policy; `tools.js` and `toolResults.js` own browser operations/results; popup scripts provide operator controls.

## Behavior and side effects

Browser permissions are extension-side policy and remain distinct from .NET Main tool authorization. WebSocket reconnect and tool-result correlation must preserve the shared Node protocol. The extension remains a real remote Node implementation while Main migration proceeds.

## Tests

`packages/browser-node/test/nodeProtocol.test.mjs`; `toolResults.test.mjs`.
