# Module: Browser Node

## Responsibility and boundaries

Browser-specific Chrome/Chromium and Firefox Manifest V3 packages cooperatively control existing logged-in tabs and shared windows. Extension APIs own sharing, tab/window lifecycle and connection configuration; a bounded Chrome `chrome.debugger`/CDP adapter or Firefox document-targeted WebExtension adapter owns top-document page operations. It does not launch a browser, export cookies, implement generic CDP forwarding or provide a filesystem/execution environment.

- [Extension implementation](../units/browser-node-extension.md) maps storage, popup, transport, CDP and tests.
- [Node communication](../threads/node-communication.md) owns pairing, authenticated discovery, result/image transport and optional ordinary-call cancellation.
- [External Nodes](../units/external-nodes.md) maps C# bootstrap assets and authenticated Browser onboarding.

## Public tools

`list_tabs`, `get_tab_content`, `screenshot`, `click`, `fill`, `select_option`, `scroll`, `navigate`, `wait_for`, `press_key`, `execute_js`, `open_tab`, `close_tab`. Firefox omits `press_key`; it has no trusted editing-key API.

### D-browser-node-distinct-tools

Extension tools use short names within their Node namespace. They operate shared existing browser tabs and remain separate from process-owned Puppeteer `browse_*` tools. There are no `browser_*` aliases. Explicit discovery/calls can target Browser Node while a development Node remains selected; ordinary Session/Node authorization still applies.

### D-browser-node-tab-policy

**Derived sharing and approval design under [caller authority](../behaviors/nodes-workspaces-and-permissions.md#authority-has-several-independent-boundaries).** Tab/page grants identify what an operation may observe or change. Origin, document and membership checks implement those permissions; broad browser host permission alone does not establish an admitted page operation.

Sharing resolves from an explicit live tab rule, then the nearest matching hostname rule, then the current shared window, then Off. Ask/Auto share basic metadata; Off discloses none. Ask gates each targeted page operation, including JavaScript. Positive direct-tab grants are origin-bound; explicit Off applies to the live tab across navigation. Tab/window IDs live only in browser-session storage. Persistent site rules include subdomains. Sharing a window dynamically includes current/new/moved-in HTTP(S) tabs; moving out removes only its window-derived grant. Clearing a tab rule restores inheritance.

Approval shows the actual Agent, Session, page and action. Document, current sharing, membership, cancellation and deadline are checked at approval/execution and before releasing page results. Navigation, revocation, moves and Stop invalidate pending work. Sharing edits also cancel in-flight targetless listings so an earlier settings read cannot authorize metadata first observed after revocation. Per-tab operations use bounded transient ordering, without durable queues, replay or selector reconstruction.

### D-browser-node-main-world-js

`execute_js` evaluates in the page context, awaits Promises and follows that page's Ask/Auto policy. Firefox additionally requires an explicit optional user-script permission and uses MAIN-world `userScripts.execute` source injection, without page eval or CSP relaxation. Ordinary snapshots/text/HTML omit password values and fill previews/results do not echo text. Explicit JavaScript remains able to access sensitive page data; omission is not a script sandbox.

### D-browser-node-debugger-control

On Chrome/Chromium, debugger permission and Chrome's visible debugging banner are part of the cooperative product. Background operations never deliberately activate a tab/window. Keep an admitted attachment between snapshot and action; navigation/detach invalidate refs. User banner Cancel or unexpected detach stops the extension and never causes automatic reattachment. Same-tab human editing can race native input; no transaction or simultaneous-edit reliability guarantee is made. Browser/enterprise restrictions and complex frames remain outside the first qualified top-document path.

### D-browser-node-connection-intent

**Derived connection-state design for the selected [browser Node capability](#d-browser-node-distinct-tools).** User connection intent and temporary transport loss have different meanings. Stored intent/reconnect mechanics implement that distinction; browser wake or a transient disconnect is not a new user authorization.

Stop persists disabled intent; startup, reconnect and alarms respect it. Forget additionally deletes credentials/bootstrap secret. Credentials bind to the normalized Main address including deployment path; a changed target requires fresh pairing, and retired pairing replies cannot install credentials. A transient network failure may reconnect only while enabled. There is no legacy Browser settings or old-tool migration path.

### D-browser-node-firefox-control

Firefox requires version 153+ for document IDs and on-demand user-script execution. Fixed DOM helpers use isolated-world scripting with the admitted document ID; arbitrary JavaScript uses MAIN and the same document target. Target-tab PNG capture never activates the tab. DOM activation/fill use synthetic events; trusted native input and `press_key` are unavailable. Broad page-host permission enables these browser APIs but does not weaken sharing. Optional user-script permission is browser-owned, requested only by an explicit popup gesture, and checked for every JS call. Ask uses the pending collection's action-badge count and existing popup cards, without notifications or automatic popup focus. Chrome retains its existing notifications and debugger driver.

## Installation and qualification

Nodes → New nodes → Browser provides authenticated setup details and credential-free runtime extension ZIPs selected by browser. C# build/publish carries the extension assets; routes and UI links preserve deployment prefixes. The default `node/browser-extension.zip` remains unpacked Chrome/Chromium. `node/browser-extension-firefox.zip` is a Firefox 153+ temporary add-on; persistent Firefox release/beta installation requires Mozilla signing and is not supplied here.

The actual packaged MV3/C# harness covers model dispatch, authorization, shared windows, page operations, stale approvals/refs, Main Stop and image history. The Firefox owned-profile driver (qualified on Linux Firefox 153.0 and 158.0.1) covers real installation/pairing/model dispatch, strict-CSP MAIN Promise execution, optional permission denial/grant/revocation, background images, DOM forms, sharing/Ask/cancellation and popup-free background lifetime. An owned Xvfb Chrome run covers foreground OS typing and actual banner Cancel. See the [extension unit](../units/browser-node-extension.md#validation) for test entries and limits. Current C# Main answers the extension's JSON ping/pong; heartbeat mismatch is not an open issue.
