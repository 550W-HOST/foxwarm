# Unit: WebUI app

Files: packages/webui/src/App.tsx, packages/webui/src/main.tsx, packages/webui/src/config.ts, packages/webui/src/EmbeddedWebUiApp.tsx, packages/webui/src/embeddedWebUi.ts, packages/webui/src/sessionListRefresh.ts, packages/webui/src/nodeTargets.ts, packages/webui/src/vscodeWeb.ts, packages/webui/src/commitMarker.ts, packages/webui/src/components/CommitMarkerCard.tsx, packages/webui/src/components/VscodeWebFrameHost.tsx, packages/webui/vite.config.ts, packages/webui/test/vscodeWebBridge.test.mjs, packages/webui/test/embeddedWebUi.test.mjs, packages/webui/test/commitMarker.test.mjs, packages/webui/test/codeFrame550aOverlay.e2e.mjs
Secondary files: packages/webui/src/boundedSessionList.ts, packages/webui/test/boundedSessionList.test.mjs, packages/webui/src/sessionIdleNotifications.ts, packages/webui/src/components/Chat.tsx, packages/webui/src/components/ChatTimeline.tsx

## Purpose

Bootstraps the browser application, routes workbench tabs, owns global list/UI preferences, selects strict embedded leaf roots, derives deployment-relative URLs, and hosts the persistent Code iframe/typed bridge.

## Key exports

- default `App`.
- `API_BASE_PATH` — current pathname without trailing slash plus `/api`.
- `makeApiUrl(relativePath)` — URL object at the current origin/API base.
- `makeWebSocketUrl(relativePath)` — URL object with `ws:`/`wss:` protocol.
- Embedded-target/message parsers, latest-session-list request gate, Code-target/URL helpers, and strict commit-marker helpers.

## URL and message helpers

- REST and EventSource callers append route fragments to `API_BASE_PATH`.
- WebSocket callers use `makeWebSocketUrl`; it is not an EventSource helper.
- `getVscodeWebPath` removes a trailing `/api` and appends `/vscode-web/`.
- `makeVscodeWebUrl` emits new-tab folder or embedded persistent-workspace startup URLs.
- Main WebUI and its persistent Code frame use exact source plus origin checks. For nested Foxwarm leaf views, the inner iframe sends to its parent with `'*'`; the outer extension validates exact source, channel, version, and random nonce but does not inspect `event.origin`. Outer-to-inner delivery targets the exact derived `frameOrigin`. No bridge accepts arbitrary Code command names or puts auth tokens in messages.

## App behavior

- Hash routing restores normal tabs plus current singleton Agents/Setup tabs; old agents/architecture/setup/oobe hash aliases remain inbound readers.
- Workbench supports split panes and drag/reorder for chat, terminal, Agents, Setup, and Code. Closing an active tab advances the hash to the store-selected fallback before hydration can recreate it.
- `GET /setup/status` controls forced OOBE. Missing models route to `system:setup`; close requests are ignored until status no longer reports OOBE.
- App owns model-settings navigation from Chat: it activates or creates the singleton `system:setup` tab through the workbench API and increments a transient Models-editor focus request.
- `useBoundedSessionList` bootstraps Sidebar through fixed `/session-list/sidebar`, `/children`, `/by-id`, and `/search` calls. It keeps normalized rows plus root/child cursors, focus paths, open tabs, and browser-local idle watches; normal App never GETs the legacy global Session list. Independent request generations reject stale root, child, exact, and search responses.
- Global `sessions-updated` invalidation refetches only the current root and expanded-child windows through the fixed-delay coalescing contract in [D-webui-app-global-list-gate](#d-webui-app-global-list-gate). Exact watched rows receive immediate SSE deltas. Opening or reopening each replacement/chunked global stream submits the same coalesced refresh intent after connection, closing the invalidation gap while subscriptions are being replaced. Agent and terminal fetches are independent of Session catalog invalidation.
- Chat per-session runtime/history remains inside Chat.
- Desktop expanded/collapsed sidebar and mobile shell share the same current tab records.
- Browser-only theme, UI style, sidebar, send-key, last-tab/session, and Code preferences use local storage. Instance branding comes from server settings.
- Browser auth storage reads only `foxwarm_token`. The browser E2E helper is exposed only as `window.foxwarmTest`.
- Main launcher options consume the authenticated node summary. Code persists its standalone node/path target in browser storage; terminal defaults follow the focused session. Session-header terminal placement reuses a lower pane only for the exact normalized node/cwd target and otherwise adds the requested target there.
- Idle-notification settings are browser-local too. App and the embedded sidebar each observe their accepted list snapshots once; the notification transition contract belongs to [webui-session-list](./webui-session-list.md#design-decisions).

## Embedded leaf roots

`main.tsx` parses strict nonce-bearing `foxwarmEmbed=sidebar|chat|agents|setup` before mounting normal App:

- sidebar owns the same bounded list/cache/global stream contract and sends fixed open actions;
- chat mounts exactly one Chat and session stream;
- Agents mounts Architecture, which owns its bounded summary/forest queries and stream;
- Setup mounts SetupView and setup APIs.

Embedded Chat sends `open-setup` with an allowlisted optional Models-focus field. The Code host activates the stable Setup custom editor and sends a separate nonce-bound one-shot `focus-models` message after the Setup leaf reports ready; Embedded Setup converts it to the same transient `SetupView` focus request used by normal App.

These are independent roots, not CSS-hidden full App instances. Active-target messages update sidebar selection; a null target clears it.

## Code and commit behavior

- Embedded launch creates one singleton Code tab. Restoring that tab without displaying it as active in a visible workbench pane leaves the top-level iframe uncreated, including while the mobile list replaces the workbench surface; its first actual display starts it. Later tab/surface changes hide/reposition the persistent iframe rather than remounting it, while explicit tab close destroys the frame and clears pending bridge state. In the 550A style, the full-screen scanline overlay remains above normal WebUI content but below the iframe so the Code workbench stays visually unobscured and interactive.
- File-tool paths become typed open-file requests only after node/path/cwd normalization; `read` ranges become selections.
- Strict standalone model-authored commit markers outside code fences render inert cards. Click dispatches typed `openCommit`; malformed/user markers remain text.
- New-tab URLs carry one-shot targets. Running iframe transfer/pop-out is not implemented.
- Changing a main Code launcher node adds that node/path resource to the same persistent multi-root workspace; it never creates a per-node Code tab or iframe.

## Dependencies

Workbench store/layout, Sidebar, Chat, Architecture, Setup, terminal view, WebUI settings, and [Code integration](../threads/code-integration.md).

## Compatibility

- Old route hashes hydrate current singleton tabs.
- Code preference storage keys and old extension editor-restore state are handled by their current owners.
- Removed workspace/file tabs are normalized by [webui-workbench](./webui-workbench.md).
- Model-settings navigation follows [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation); no direct hash-writing compatibility entry point is added.

## Design decisions

### D-webui-app-route-close

Advance the route/hash to the workbench fallback before a closed active tab can be rehydrated.

### D-webui-app-global-list-gate

[2026-07-30; updated 2026-08-11] Global `sessions-updated` refresh intents use one non-sliding, visibility-aware delay shared by normal App and embedded Sidebar/Agents list-data roots: 1 second when the page is visible and 10 seconds otherwise. Each first idle or trailing arm samples visibility once; later intents and visibility changes do not move an already fixed deadline. Intents received while a refresh is in flight coalesce into exactly one trailing refresh, whose new delay is chosen after the current refresh settles. Scheduled refreshes never overlap, and disposal cancels pending timers and suppresses trailing work. Initial bounded bootstrap remains immediate. Each newly opened or reconnected global Session-list EventSource batch submits this same coalesced refresh after connection, so an invalidation lost during subscription replacement cannot leave the bounded window stale; sibling batch opens still produce one effective refresh, and unchanged subscription IDs do not reconnect or loop. Session catalog invalidation refetches current bounded list windows only; agent/terminal lists are decoupled. Independent root/child/exact/search generations prevent older responses from overwriting newer state.

### D-webui-app-leaf-embeds

Code-embedded sidebar/chat/Agents/Setup are strict leaf roots with allowlisted messages, not nested copies of the workbench shell.

### D-webui-app-persistent-code-frame

The Code workbench tab is a launcher/slot. The portal-owned iframe starts only when Code is first visible in an active pane, persists across ordinary hiding after that first start, and is destroyed with its bridge state on explicit tab close. The full lifecycle contract is canonical in [D-code-persistent-workspace](../threads/code-integration.md#d-code-persistent-workspace).

### D-webui-app-client-preferences

Theme/style/layout/navigation/Code launch choices stay browser-local unless the setting is explicitly instance-wide.
