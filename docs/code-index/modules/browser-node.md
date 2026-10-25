# Module: Browser Node

## Responsibility and boundaries

A Chrome/Chromium Manifest V3 extension cooperatively controls existing logged-in tabs and shared windows. Extension APIs own sharing, tab/window lifecycle and connection configuration; one bounded `chrome.debugger`/CDP adapter owns top-document page operations. It does not launch a browser, export cookies, implement generic CDP forwarding or provide a filesystem/execution environment.

- [Extension implementation](../units/browser-node-extension.md) maps storage, popup, transport, CDP and tests.
- [Node communication](../threads/node-communication.md) owns pairing, authenticated discovery, result/image transport and optional ordinary-call cancellation.
- [External Nodes](../units/external-nodes.md) maps C# bootstrap assets and authenticated Browser onboarding.

## Public tools

`list_tabs`, `get_tab_content`, `screenshot`, `click`, `fill`, `select_option`, `scroll`, `navigate`, `wait_for`, `press_key`, `execute_js`, `open_tab`, `close_tab`.

### D-browser-node-distinct-tools

Extension tools use short names within their Node namespace. They operate shared existing browser tabs and remain separate from process-owned Puppeteer `browse_*` tools. There are no `browser_*` aliases. Explicit discovery/calls can target Browser Node while a development Node remains selected; ordinary Session/Node authorization still applies.

### D-browser-node-tab-policy

Sharing resolves from an explicit live tab rule, then the nearest matching hostname rule, then the current shared window, then Off. Ask/Auto share basic metadata; Off discloses none. Ask gates each targeted page operation, including JavaScript. Positive direct-tab grants are origin-bound; explicit Off applies to the live tab across navigation. Tab/window IDs live only in browser-session storage. Persistent site rules include subdomains. Sharing a window dynamically includes current/new/moved-in HTTP(S) tabs; moving out removes only its window-derived grant. Clearing a tab rule restores inheritance.

Approval shows the actual Agent, Session, page and action. Document, current sharing, membership, cancellation and deadline are checked at approval/execution and before releasing page results. Navigation, revocation, moves and Stop invalidate pending work. Per-tab operations use bounded transient ordering, without durable queues, replay or selector reconstruction.

### D-browser-node-main-world-js

`execute_js` evaluates in the page context, awaits Promises and follows that page's Ask/Auto policy. Ordinary snapshots/text/HTML omit password values and fill previews/results do not echo text. Explicit JavaScript remains able to access sensitive page data; omission is not a script sandbox.

### D-browser-node-debugger-control

Debugger permission and Chrome's visible debugging banner are part of the cooperative product. Background operations never deliberately activate a tab/window. Keep an admitted attachment between snapshot and action; navigation/detach invalidate refs. User banner Cancel or unexpected detach stops the extension and never causes automatic reattachment. Same-tab human editing can race native input; no transaction or simultaneous-edit reliability guarantee is made. Browser/enterprise restrictions and complex frames remain outside the first qualified top-document path.

### D-browser-node-connection-intent

Stop persists disabled intent; startup, reconnect and alarms respect it. Forget additionally deletes credentials/bootstrap secret. Credentials bind to the normalized Main address including deployment path; a changed target requires fresh pairing, and retired pairing replies cannot install credentials. A transient network failure may reconnect only while enabled. There is no legacy Browser settings or old-tool migration path.

## Installation and qualification

Nodes → New nodes → Browser provides authenticated setup details and a credential-free runtime extension ZIP. C# build/publish carries the extension assets; routes and UI links preserve deployment prefixes. The first distribution is unpacked Chrome/Chromium, not a store or Firefox claim.

The actual packaged MV3/C# harness covers model dispatch, authorization, shared windows, page operations, stale approvals/refs, Main Stop and image history. An owned Xvfb run covers foreground OS typing and actual banner Cancel. See the [extension unit](../units/browser-node-extension.md#validation) for test entries and limits. Current C# Main answers the extension's JSON ping/pong; heartbeat mismatch is not an open issue.
