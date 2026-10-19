# Unit: WebUI app

Files: packages/webui/src/App.tsx, packages/webui/src/WebUiIdentityApp.tsx, packages/webui/src/main.tsx, packages/webui/src/config.ts, packages/webui/src/EmbeddedWebUiApp.tsx, packages/webui/src/embeddedWebUi.ts, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/sessionListRefresh.ts, packages/webui/src/nodeTargets.ts, packages/webui/src/vscodeWeb.ts, packages/webui/src/commitMarker.ts, packages/webui/src/components/CommitMarkerCard.tsx, packages/webui/src/components/VscodeWebFrameHost.tsx, packages/webui/vite.config.ts, packages/webui/package.json, packages/webui/package-lock.json, packages/webui/pnpm-lock.yaml, packages/webui/test/reactRendererAliases.mjs, packages/webui/test/vscodeWebBridge.test.mjs, packages/webui/test/embeddedWebUi.test.mjs, packages/webui/test/popupWebUi.test.mjs, packages/webui/test/popupMove.e2e.mjs, packages/webui/test/experimentHostScopedPreferences.e2e.mjs, packages/webui/test/nodeTargets.test.mjs, packages/webui/test/commitMarker.test.mjs
Secondary files: packages/webui/src/realtime.ts, packages/webui/src/boundedSessionList.ts, packages/webui/src/components/CollapsedSidebarContainer.tsx, packages/webui/test/boundedSessionList.test.mjs, packages/webui/src/sessionIdleNotifications.ts, packages/webui/src/components/Chat.tsx, packages/webui/src/components/ChatTimeline.tsx

## Purpose

Bootstraps the browser application, routes workbench tabs, owns global list/UI preferences, selects strict embedded leaf roots, derives deployment-relative URLs, and hosts the persistent Code iframe/typed bridge.

## Key exports

- default `App`.
- `API_BASE_PATH` — current pathname without trailing slash plus `/api`.
- `makeApiUrl(relativePath)` — URL object at the current origin/API base.
- `makeWebSocketUrl(relativePath)` — URL object with `ws:`/`wss:` protocol.
- Embedded-target/message parsers, latest-session-list request gate, Code-target/URL helpers, and strict commit-marker helpers.

## URL and message helpers

- REST and compatibility EventSource callers append route fragments to `API_BASE_PATH`.
- WebSocket callers use `makeWebSocketUrl`; the page realtime transport uses it for the shared `/webui/stream` socket.
- `getVscodeWebPath` removes a trailing `/api` and appends `/vscode-web/`.
- `makeVscodeWebUrl` emits new-tab folder or embedded persistent-workspace startup URLs.
- Main WebUI and its persistent Code frame use exact source plus origin checks. For nested Foxwarm leaf views, the inner iframe sends to its parent with `'*'`; the outer extension validates exact source, channel, version, and random nonce but does not inspect `event.origin`. Outer-to-inner delivery targets the exact derived `frameOrigin`. No bridge accepts arbitrary Code command names or puts auth tokens in messages.

- Tool-card Code actions prefer the successful response path and recorded execution Node, not the Session's later Node/cwd; only older absolute paths retain the legacy fallback. The Code bridge still validates the resolved absolute target and authorizes open operations separately. See [D-dispatch-native-agent-paths-and-code-targets](../threads/tool-dispatch-node-execution.md#d-dispatch-native-agent-paths-and-code-targets).
## App behavior

- `main.tsx` resolves `/api/auth/session` before mounting any browser root. Administrator tokens retain the normal app, strict Code-embedded leaves, and top-level popup leaves; WebUI identity tokens mount only `WebUiIdentityApp`, irrespective of popup/embedded URL parameters. This restricted identity root offers a bounded-Session chat selector without mounting the administrator workbench or list controller. It renders the server-projected current IDs after a successful identity move, while its initial auth payload also names current live IDs. A popup therefore does not initialize the normal workbench store. Vite resolves WebUI imports against one React 18 runtime rather than an aliased renderer; browser JSX fixtures use that same package-local runtime. The module-level contract is [D-webui-react18-runtime](../modules/webui.md#d-webui-react18-runtime).
- Route hydration activates an existing target when the route ID changes or the target first becomes available, not when workbench focus or tab metadata changes. This prevents an outgoing route from reactivating its previous Session while an explicit activation publishes its new hash.
- Hash routing restores normal tabs plus current singleton Agents/Setup/Logs/Tasks/Nodes tabs and independently routed History tabs; old agents/architecture/setup/oobe hash aliases and `system:search` remain inbound readers. The History leaf/popout and deployment-relative viewer routes are documented in [webui-history-search](./webui-history-search.md).
- A tab context-menu popout opens synchronously, removes the source tab only after `window.open` returns a handle, and uses the ordinary route-fencing/fallback publication without invoking resource close. Setup and Agents require a synchronous warning confirmation. A terminal without a resolved backend ID cannot move. Code opens its current launcher node/path through the existing standalone URL helper and destroys the embedded frame only after the standalone window opens.
- Desktop inset shell and the icon/label/count status footer are documented in [Workbench behavior](./webui-workbench.md#behavior). The footer belongs to the right workbench column, never shortens Sidebar, and is not mounted in mobile navigation or popup/embedded leaf roots.
- Workbench supports split panes and drag/reorder for chat, terminal, Agents, Setup, Search, Logs, Tasks, Nodes, and Code. Each sole non-Code tab uses the current-pane header Close/icon path described in [Single-tab headers](./webui-workbench.md#single-tab-headers). User activation of a tab in a collapsed pane expands that pane; route/hash hydration passes the store's non-expanding activation option so persisted collapsed layouts remain collapsed on reload. The shared tab-owned content host evaluates the actual renderer inside its error boundary; content lifetime and layout independence are canonical in [D-workbench-stable-content](./webui-workbench-content.md#d-workbench-stable-content). Closing an active tab advances the hash to the store-selected fallback before hydration can recreate it. The fallback-route effect resolves the current focused pane and verifies its active tab against the live store and existing closing intent before publishing; a render-captured ID removed during asynchronous resource close cannot restore the closed hash.
- Explicit Workbench navigation carries a transient tab-reveal request, including same-ID activation. Pane focus still synchronizes the route but does not request strip scrolling. The canonical behavior is [Tab navigation and manual scrolling](./webui-workbench.md#d-workbench-tab-navigation).
- A Chat preview and kept tab share the Session-derived `chat:<sessionId>` ID. Opening another Session replaces the one preview tab in its existing pane, changing both its content and hash; editing or sending a draft does not keep it. Double-click, the tab Keep menu, Sidebar double-click/drag into the workbench, and a successful tab reorder/move/dock keep explicitly by clearing the preview flag. A no-op or canceled drag leaves the preview unchanged. Navigating to `#tab/chat:<sessionId>` or an inbound `#session/<sessionId>` selects an existing tab without changing its keep status, or opens a preview if absent.
- `GET /setup/status` controls forced OOBE. Missing models route to `system:setup`; close requests are ignored until status no longer reports OOBE.
- App owns model-settings navigation from Chat: it activates or creates the singleton `system:setup` tab through the workbench API and increments a transient Models-editor focus request. The request is cleared once SetupView consumes it, so remounts and ordinary Setup opens keep their own tab.
- `useBoundedSessionList` bootstraps Sidebar through fixed `/session-list/sidebar`, `/children`, `/by-id`, and `/search` calls. It keeps normalized rows plus root/child cursors, focus paths, open tabs, and browser-local idle watches; normal App never GETs the legacy global Session list. Independent request generations reject stale root, child, exact, and search responses.
- Exact lookup and subscription dependencies use a canonical ID set, so moving focus among already-open/watched Sessions does not refetch the same set in a different order. Focus changes still request their server-owned root/path windows. Global summary bootstrap is independent of those focus queries; later summaries refresh only through the normal explicit/invalidation/reconnect path.
- Global `sessions-updated` invalidation refetches only the current root and expanded-child windows through the fixed-delay coalescing contract in [D-webui-app-global-list-gate](#d-webui-app-global-list-gate). Exact watched rows receive filtered deltas through their logical subscription. Registering a new physical socket submits the same coalesced refresh intent, closing the reconnect invalidation gap. Agent and terminal fetches are independent of Session catalog invalidation.
- App keeps persisted terminal tab records until the initial active-terminal registry request settles; only the loaded registry reconciles missing backend terminals away. This prevents the first render's null loading snapshot from removing a valid restored terminal before its resource lookup completes.
- Chat per-session runtime/history remains inside Chat. Ordinary, popup, embedded, and restricted identity roots project the same browser-local `timelineView`, commentary and inter-agent display preferences; the restricted root consumes these read-only preferences without adding controls or broadening its identity scope. See [D-webui-timeline-view](../modules/webui-timeline.md#d-webui-timeline-view).
- Desktop expanded/collapsed sidebar and mobile shell share the same current tab records. The main bounded controller remains top-level for tabs, metadata, summaries, notifications, and expanded/mobile presentation. The collapsed desktop rail owns a second 20-root controller only inside its conditionally mounted container; expanded desktop and every mobile surface create no collapsed controller, bootstrap, scheduler, or logical realtime subscription.
- The shared theme runtime initializes before React and owns browser-local theme package/selection state. Sidebar, send-key, last-tab/session, and Code preferences also use local storage. Instance branding comes from server settings.
- The [HTML startup screen](./webui-fox-loaders.md) precedes external modules and stays until auth plus the selected root have mounted, or auth recovery is visible. A root error boundary reports uncaught render/import errors to the same HTML recovery screen; it does not create a second React splash.
- The independently served [token sign-in page](./webui-login.md) reuses theme/fox sources without mounting App. Browser auth storage reads only `foxwarm_token`. The browser E2E helper is exposed only as `window.foxwarmTest`.
- Main launcher options consume the authenticated node summary. Code persists its standalone node/path target in browser storage; terminal defaults follow the focused session. Desktop terminal launch follows the focused Chat's node/cwd or the Code workspace target through the status-bar [Terminal panel contract](./webui-workbench.md#d-workbench-terminal-panel). Mobile retains the header callback and its exact lower-pane target matching.
- Node-target normalization preserves a connected protocol-incompatible target for diagnosis but makes it unavailable with an `upgrade required` label, so Code and Terminal launch controls cannot dispatch through it. Canonical contract: [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).
- Idle-notification settings and unread idle-completion attention are browser-local too. App and the embedded sidebar each observe their accepted list snapshots once and retain only the latest successfully created page Notification per canonical session from that root, replacing the prior same-session handle without affecting other sessions. App supplies every actually rendered active split-pane Chat (or the one visible mobile pane). Notification clicks use a notification-origin `openChatTab` activation that preserves normal workbench/hash navigation but skips its ordinary eager row/tab acknowledgement, then rely on actual visible-session reconciliation; Code uses the existing nonce-bound `open-session` host action. Lifecycle, acknowledgement, and closed-page limitations are canonical in [webui-session-list](./webui-session-list.md#design-decisions).

## Embedded leaf roots

`main.tsx` parses strict nonce-bearing `foxwarmEmbed=sidebar|chat|agents|setup` before mounting normal App:

- sidebar owns the same bounded list/cache/global stream contract and sends fixed open actions;
- chat mounts exactly one Chat and logical session subscription;
- Agents mounts Architecture, which owns its bounded summary/forest queries and logical list subscription;
- Setup mounts SetupView and setup APIs.

Embedded Chat sends `open-setup` with an allowlisted optional Models-focus field. The Code host activates the stable Setup custom editor and sends a separate nonce-bound one-shot `focus-models` message after the Setup leaf reports ready; Embedded Setup converts it to the same transient `SetupView` focus request used by normal App, which clears it after consumption.

These are independent roots, not CSS-hidden full App instances. Active-target messages update sidebar selection; a null target clears it. The same nonce-bound payload may include all active Code Chat editor session IDs so the embedded sidebar can apply the canonical unread visibility contract.

## Top-level popup leaf roots

`foxwarmPopupVersion=1` plus `foxwarmPopup=chat|terminal|agents|search|logs|tasks|nodes|setup` selects a real top-level leaf at the current deployment pathname. Chat and terminal require a bounded session/terminal ID; optional titles are presentation only. The popup imports no workbench shell, tabs, panes, sidebar, or persisted workbench store. Chat session links and Configure Models navigate to another popup leaf URL rather than hydrating the normal App. Setup uses its ordinary APIs and browser settings, Agents refetches its server state, and terminal reattaches by exact terminal ID. There is no opener bridge, state transfer, close restoration, or cross-window synchronization.

## Code and commit behavior

- Embedded launch creates one singleton Code tab. App's `useVscodeWebFrameBridge` controller remains mounted before lazy iframe admission, preserving first file/commit requests while the frame starts and clearing pending work on explicit Close. `VscodeWebFrameHost` renders only the frame inside the shared tab-owned host. Code-specific persistence is canonical in [D-code-persistent-workspace](../threads/code-integration.md#d-code-persistent-workspace); positioning and layout-independent identity are canonical in [D-workbench-stable-content](./webui-workbench-content.md#d-workbench-stable-content).
- File-tool paths become typed open-file requests only after node/path/cwd normalization; `read` ranges become selections.
- Strict standalone model-authored commit markers outside code fences render inert cards. Click dispatches typed `openCommit`; malformed/user markers remain text.
- Chat supplies a single ordinary Code launch callback, retaining the browser-local opening preference. Header action presentation is owned by [D-chat-header-launch-actions](./webui-chat.md#d-chat-header-launch-actions).
- New-tab URLs carry one-shot targets. Running iframe transfer/pop-out is not implemented.
- Changing a main Code launcher node adds that node/path resource to the same persistent multi-root workspace; it never creates a per-node Code tab or iframe.

Logs is a lazy singleton `system:logs` tab with normal route restoration, close fallback and same-origin `logs` popup leaf. Code-embedded Sidebar opens this leaf directly without changing the Code host protocol. Its file/transport contract is canonical in [WebUI Logs](./webui-logs.md).

Tasks is a lazy singleton `system:tasks` tab with the shared restoration, close and popup behavior. Its read-only Table/Board and bounded API reads are documented in [WebUI Tasks](./webui-tasks.md).

Nodes is a lazy singleton `system:nodes` tab with ordinary activation, restore, close and popup behavior. Its independent directory/onboarding ownership and Architecture summary entry are documented in [WebUI Nodes](./webui-nodes.md).

## Build and browser fixtures

- The WebUI builds with Vite 8's native Rolldown/Oxc pipeline and `@vitejs/plugin-react` 6. React 18 remains unchanged; optional React Compiler peers are neither installed nor enabled. The explicit `esbuild` development dependency is available to build helpers and standalone browser fixtures, not selected as Vite's bundler or minifier.
- Source builds require Node.js `^20.19.0 || >=22.12.0`. The explicit `build.target` retains Vite 5's syntax targets (`es2020`, Edge 88, Firefox 78, Chrome 87, Safari 14); it is not a polyfill or a promise that every application API works in those browser versions.
- `base: './'` keeps emitted HTML, dynamic imports, styles, and worker URLs deployment-relative. Rolldown owns automatic code splitting; the old Monaco manual group is removed so shared preload helpers cannot drag Monaco into the initial entry graph. YAML/JSON/editor worker constructors remain Vite `?worker` imports in the lazy editor loader.
- Setup's real-browser fixture serves the unmodified relative production build through Vite preview mounted at `/production/foxwarm/`, alongside the development `/preview/` path. It exercises actual YAML worker diagnostics/completions and the savable import-failure fallback. The JSON inspector fixture exercises the development worker pipeline in Chromium and Firefox.

## Dependencies

Workbench store/layout, Sidebar, Chat, Architecture, Setup, terminal view, WebUI settings, and [Code integration](../threads/code-integration.md).

## Compatibility

- Old route hashes hydrate current singleton tabs.
- Code preference storage keys and old extension editor-restore state are handled by their current owners.
- Removed workspace/file tabs are normalized by [webui-workbench](./webui-workbench.md).
- Model-settings navigation follows [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation); no direct hash-writing compatibility entry point is added.

## Design decisions

### D-webui-app-route-close

[2026-08-14] App owns route publication for Workbench close actions. An ordinary active-tab close fences the routed tab before the synchronous store removal, then immediately publishes the store-selected fallback; when the final closable tab has no protected forced Setup fallback, the Workbench may remain empty for the rest of the current mount and App clears the hash plus last-active-tab preference. Bulk close pre-fences every closable target, runs the sequential per-tab resource and component close lifecycle with intermediate route/hash publication deferred, and publishes exactly one final store-selected fallback afterward. `Close others` therefore preserves its selected target, while `Close all` leaves an empty pane/hash/preference when no protected Setup tab remains. Reload or explicit navigation may create or restore a tab later.

### D-webui-app-global-list-gate

[2026-07-30; updated 2026-09-05] Global `sessions-updated` refresh intents use one non-sliding, visibility-aware delay shared by normal App and embedded Sidebar/Agents list-data roots: 1 second when the page is visible and 10 seconds otherwise. Each first idle or trailing arm samples visibility once; later intents and visibility changes do not move an already fixed deadline. Intents received while a refresh is in flight coalesce into exactly one trailing refresh, whose new delay is chosen after the current refresh settles. Scheduled refreshes never overlap, and owner disposal cancels pending timers and suppresses trailing work. Each mounted bounded controller keeps one stable scheduler whose callback dereferences the latest refresh operation, so focus or request-callback changes cannot cancel an already accepted physical-generation safety intent. Initial bounded bootstrap remains immediate. The transport identifies the physical socket generation when a logical subscription opens. Each bounded controller submits one coalesced race-closing refresh for its initial registration and one for every later physical reconnect, but remembers the last accepted generation so focus-ID or other logical subscription churn on the same socket cannot schedule a duplicate refresh. Session catalog invalidation refetches current bounded list windows only; agent/terminal lists are decoupled. Independent root/child/exact/search/badge/summary generations plus a mount-ownership epoch prevent stale StrictMode passes, replaced queries, refresh continuations, or terminal unmounts from publishing or launching follow-up work. Physical connection ownership is canonical in [D-webui-multiplexed-realtime](../threads/streaming-pipeline.md#d-webui-multiplexed-realtime).

### D-webui-app-leaf-embeds

Code-embedded sidebar/chat/Agents/Setup are strict leaf roots with allowlisted messages, not nested copies of the workbench shell.

### D-webui-app-popup-leaves

[2026-09-21] Top-level popup leaves are real same-origin pages selected by a separate versioned URL parser. They are not Code embeds and do not send or accept the nonce-bound embed-host protocol. Dynamic root imports keep the normal App/workbench store out of popup startup. Popout is intentionally reopen-and-remove rather than live DOM/React/iframe transfer: no state handoff, opener lifecycle manager, or automatic return is provided.

### D-webui-app-persistent-code-frame

Code-specific persistence is canonical in [D-code-persistent-workspace](../threads/code-integration.md#d-code-persistent-workspace). The shared Workbench host owns iframe geometry and layout-independent identity under [D-workbench-stable-content](./webui-workbench-content.md#d-workbench-stable-content).

### D-webui-app-client-preferences

Theme package/selection, layout, navigation, and Code launch choices stay browser-local unless the setting is explicitly instance-wide. Theme details are owned by [webui-theme-system](./webui-theme-system.md).

App stages a selected desktop Chat before replacing its preview, and supplies readable already-loaded Session names to communication cards. See [Session navigation](../threads/webui-session-navigation.md) and [Session messages](./webui-session-messages.md).

Windows drive paths normalize to the existing slash-based Code URI representation at presentation; stored Session cwd and ordinary tool metadata remain native. See [Code URI ownership](../threads/code-integration.md#d-code-real-path-uri).

Code target parsing/preferences and commit markers use the shared Core Node identity grammar, preserving qualified Provider IDs through encoded workspace/file/commit URLs rather than silently selecting master. This does not add Code capabilities to primitive providers. See [generic Node namespaces](../threads/tool-dispatch-node-execution.md#d-dispatch-generic-node-providers).
