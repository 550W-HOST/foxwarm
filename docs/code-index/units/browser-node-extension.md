# Unit: Browser Node extension

Files: `packages/browser-node/manifest.json`, `packages/browser-node/README.md`, `packages/browser-node/background/main.js`, `packages/browser-node/background/websocket.js`, `packages/browser-node/background/nodeProtocol.js`, `packages/browser-node/background/tools.js`, `packages/browser-node/background/cdp.js`, `packages/browser-node/background/pageFunctions.js`, `packages/browser-node/background/toolResults.js`, `packages/browser-node/background/permissions.js`, `packages/browser-node/background/storage.js`, `packages/browser-node/popup/popup.html`, `packages/browser-node/popup/popup.js`, `packages/browser-node/popup/popup.css`, `packages/browser-node/test/nodeProtocol.test.mjs`, `packages/browser-node/test/toolResults.test.mjs`, `packages/browser-node/test/pairingStatus.test.mjs`, `packages/browser-node/test/sharing.test.mjs`, `packages/browser-node/test/x11.py`

## Purpose and contracts

The plain-module Chrome MV3 extension supplies the cooperative shared-browser product defined by the [Browser Node module](../modules/browser-node.md). Short tool names are self-advertised on the existing Node connection; there is no compatibility alias or alternate scripting/screenshot driver.

## File responsibilities

- `manifest.json`: Chrome 120+ manifest minimum, qualified with Chrome 145 on Linux; tabs/debugger/webNavigation/storage/notifications/alarms, module worker and popup. No host grants, activeTab or scripting driver.
- `storage.js`: serialized connection/site writes in local storage and live tab/window sharing in session storage. Main normalization preserves deployment paths. Credential installation checks current target and enabled intent.
- `permissions.js`: one tab/site/window/Off resolver, transient Ask requests, full action previews, expiry/cancellation and async validation on Allow. Notifications only draw attention to the popup; closing one denies the pending request.
- `main.js`: local popup dispatch, reconnect wakeups and tab/window lifecycle invalidation. Rule changes cancel affected calls/confirmations; losing sharing detaches its page.
- `websocket.js`: exact-socket pairing/authentication, persisted-enabled admission, bounded heartbeat/reconnect, up to 32 active calls, per-call deadlines/abort signals and correlated `tool_call_cancel`. Stop aborts pending work, closes the socket and detaches. Late replies never move to a new socket or changed Main.
- `tools.js`: exact approved schemas/copy, tab/window admission, document capture before the per-tab ordering lane, Ask and execution/result checks. `open_tab` requires a shared destination window and creates inactive; closing a last tab can close its window.
- `cdp.js`: one tab-targeted Page/Runtime/Input adapter, retained attachments, isolated-world DOM helpers, page identities, screenshots and supported input. It never activates windows, retries actions or exposes arbitrary CDP commands. Unexpected detach stops connection intent.
- `pageFunctions.js`: bounded DOM snapshot/text/HTML extraction with password omission, current-snapshot element maps, unique selector checks, focus/select/scroll helpers and fixed wait conditions. Old refs are not reconstructed.
- `toolResults.js`: current structured PNG `inlineData` envelope consumed by the established Main image path.
- `popup/*`: Main setup, Stop/Forget, tabs grouped by window, explicit Off/Ask/Auto and Clear-to-inherit, persistent site editing and actual Agent/Session/page/action approval cards. Fill previews mask entered text.

## Page operations

Snapshots return at most 400 visible semantic/interactive elements with opaque references from the latest snapshot; text/HTML and explicit JS results are bounded. Reference and selector operations target the top document. Selectors must match exactly one element. Coordinate clicks bind to a screenshot page identity and use viewport CSS pixels. Native CDP mouse/text/editing-key input is tab-targeted; select and scroll use fixed DOM helpers. `wait_for` exposes element visible/hidden/attached, visible text and exact URL conditions within the remaining call deadline. JavaScript uses page context and awaits Promises under CSP; it remains privileged page access.

Navigation waits for the requested document commit, then resolves sharing before reporting the resulting identity. Navigation can intentionally end sharing; no destination content is released in that case. Ordinary calls keep identity checks internal; stale targets fail and require a fresh snapshot/screenshot.

## Connection and packaging integration

Pairing and authenticated registration retain the shared core Node protocol range 1–2 and omitted-protocol legacy response reader; this is shared transport compatibility, not old Browser configuration migration. Approved pairing discards the bootstrap token. JSON ping every 25 seconds is answered by current C# Main; reconnect alarms respect disabled intent. No self-port keepalive exists. Main transport uses only a WebSocket; no cross-origin fetch/XHR or host-permission page driver remains. The packaged extension is qualified without broad HTTP/HTTPS host grants.

The C# publish carries extension assets through `Delivery.targets`; `NodeBootstrap` assembles a credential-free ZIP from those runtime files. Authenticated `NodeRoutes` Browser setup returns the normalized Main address and private pairing token. Production `NodeOnboardingModal` exposes download, load-unpacked, pair/approve/share steps and the debugger banner. Deployment-relative URLs preserve non-root mounts. These C# and UI files remain owned by their existing units.

## Validation

- `packages/browser-node/test/*.test.mjs`: shared protocol responses, current image envelope, target/Stop/Forget/late-pairing lifecycle, sharing precedence/session storage, stale/expired/canceled Ask.
- `packages/webui/test/experimentHostBrowserNode.e2e.mjs`: existing disposable host fixture, published-runtime ZIP installed as the real MV3 extension, non-root setup, real model discovery/explicit routing/authorization, DOM refs, duplicate selectors, forms, strict CSP/Promise, target screenshots/image history, sharing/window membership, stale approvals and Main Stop, credential host switch, heartbeat and Stop/Forget past alarms. Ordinary entry is headless regardless of inherited `DISPLAY`. The explicit test-only `--owned-xvfb` flag, used with `xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp'`, also checks foreground OS typing and actual Chrome banner Cancel; `x11.py` is only that owned-display test's driver.
- `experimentHostExternalNodes.e2e.mjs`: retained broader official-client protocol/authorization/CLI qualification and current Browser tool names/sharing path.
- `experimentHostNodeOnboarding.e2e.mjs`: original production App Browser choice, prefixed download and authenticated pairing details alongside existing CLI onboarding.

These tests own config, credentials, ports and profiles. They do not qualify personal logins, enterprise restrictions, every OS/compositor/window state, store publication, Firefox, complex frames or simultaneous human editing of the same tab.
