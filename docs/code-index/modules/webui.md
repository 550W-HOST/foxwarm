# Module: WebUI

## Responsibility

Owns the browser application and WebUI-facing server surface: workbench/session navigation, chat/history streaming, message/tool rendering, composer/ASR, setup/settings, terminal client, and optional Code integration.

## Units

- [webui-app](../units/webui-app.md) — entry, routing, global list state, embedded leaf roots, URL helpers, and Code frame host.
- [webui-session-list](../units/webui-session-list.md) — hierarchy, search, order, pinning, and drag behavior.
- [webui-architecture-view](../units/webui-architecture-view.md) — agent/session architecture.
- [webui-chat](../units/webui-chat.md) — per-session history, logical realtime events, sending/commands, ASR, and viewport state.
- [webui-logs](../units/webui-logs.md) — bounded fixed-file logger history, live tail, and approximate date navigation.
- [webui-realtime](../units/webui-realtime.md) — one page-scoped multiplexed WebSocket, revisioned logical subscriptions, and server hub.
- [webui-chat-composer](../units/webui-chat-composer.md) — draft/input, autocomplete, attachments, and model controls.
- [webui-chat-shared](../units/webui-chat-shared.md), [timeline](../units/webui-chat-timeline.md), [pasted text](../units/webui-pasted-text.md), [tool timeline](../units/webui-tool-timeline.md) — sanitized rendering, user pasted-text previews, and progress/tool cards.
- [webui-workbench](../units/webui-workbench.md) — persisted tab/pane layout and compatibility normalization.
- [webui-setup-view](../units/webui-setup-view.md), [webui-settings](../units/webui-settings.md), [settings menu](../units/webui-settings-menu.md).
- [webui-theme-system](../units/webui-theme-system.md) — versioned portable manifests, built-ins, browser-local registry/selection, semantic runtime, Setup management, and renderer adapters.
- [webui-terminal](../units/webui-terminal.md) — xterm browser client.
- [webui-editor](../units/webui-editor.md), [small components](../units/webui-small-components.md).
- [src-channels-webui](../units/src-channels-webui.md) — authenticated HTTP/SSE/upload/setup/terminal routes.
- Session list/state/history/settings routes and session update streams consume immutable SessionRuntime DTOs; destructive lifecycle and channel-attachment routes retain their explicit manager-owned coordination boundary.
- [VS Code Web routes](../units/src-vscode-web-routes.md) and [extensions](../units/vscode-web-extensions.md).

## URL and transport boundaries

- `API_BASE_PATH` is the current page pathname (without trailing slash) plus `/api`.
- REST and compatibility EventSource paths append to `API_BASE_PATH`; current list/Chat realtime uses one `makeWebSocketUrl` connection.
- `makeApiUrl` returns a URL object; `makeWebSocketUrl` changes its protocol to `ws:`/`wss:`.
- Code routes remove the `/api` suffix and append deployment-relative `/vscode-web/`.
- Main WebUI and the persistent Code frame validate exact origin plus window source. Nested Foxwarm leaf iframes post to their parent with `'*'`; the outer Code extension validates exact source plus channel/version/random nonce (not `event.origin`), then sends outer-to-inner messages to the exact leaf `frameOrigin`. These bridges are not API URL transport.
- Top-level tab popups use a separate versioned same-origin URL mode. They mount one Chat, terminal, Agents, Search, Logs, or Setup leaf without the workbench store; Code uses its existing standalone `/vscode-web/` URL. Popup target IDs may be URL parameters, but authentication tokens never are.
- Download and extension routes preserve reverse-proxy prefixes and do not assume site root.

## State ownership

- Mounted Chat owns one session's history and logical runtime subscription; the page realtime transport owns the physical connection.
- App/Sidebar/Architecture own their list data and logical subscriptions on the shared transport. Stream-triggered refreshes use fixed-delay, non-overlapping coalescing, while the session-list request gate remains latest-wins; the canonical contract is [D-webui-app-global-list-gate](../units/webui-app.md#d-webui-app-global-list-gate).
- Workbench store owns tab/pane/split layout. Chat viewport state is ephemeral in-memory state keyed by canonical session ID.
- Browser-only theme packages/selection, chat/input display preferences, layout, draft, and Code preferences remain local; instance name/icon are server settings.

## Invariants

- Markdown is sanitized; math supports only documented delimiters with trusted rendering disabled.
- Strict commit markers are model-only standalone lines outside code fences and stay inert until clicked.
- CTX-BLOCK expansion is local read-only preview and never mutates active history or queue state.
- Chat/tool/markdown containers remain shrinkable; only intentional inner table/output surfaces own horizontal scrolling.
- Browser terminals are identified by node and cwd, not chat session ID.
- Optional official Code assets remain outside the main WebUI bundle.
- Missing model configuration forces the singleton Setup tab and prevents it from closing until setup status clears.
- Models/app YAML assistance uses frontend-owned static schemas and local unsaved-document suggestions; canonical saves remain backend-validated.
- Built-in and imported themes share one strict manifest/runtime path; theme IDs are not component-rendering branches. Canonical contract: [D-webui-theme-runtime-parity](../units/webui-theme-system.md#d-webui-theme-runtime-parity).
- The browser application and its browser component fixtures use the same React 18 runtime; this does not change the separate CLI/TUI dependencies. See [D-webui-react18-runtime](#d-webui-react18-runtime).

## Canonical threads

- [Global history search viewer](../units/webui-history-search.md) — read-only Search workbench tab, exact message references, and independent result timelines; retrieval contract is [D-context-history-search-viewer](../threads/context-compaction-and-recall.md#d-context-history-search-viewer).

- [streaming pipeline](../threads/streaming-pipeline.md)
- [context compaction and recall](../threads/context-compaction-and-recall.md)
- [image blob lifecycle](../threads/image-blob-lifecycle.md)
- [Code integration](../threads/code-integration.md)
- [node communication](../threads/node-communication.md)

## Compatibility

- Supported legacy bracketed system/source history remains renderable.
- Old workbench `workspace`/`file` tabs are removed during read normalization; current writes never recreate them.
- Old `#agents`/`#architecture` and `#setup`/`#oobe` hashes hydrate current singleton system tabs.

## Design decisions

### D-webui-react18-runtime

[2026-09-19] The WebUI uses its locked React and ReactDOM 18.3.1 packages directly for JSX, hooks, and `createRoot`; Vite does not alias React to Preact. Browser component fixtures also resolve the WebUI's React 18 packages, including when their generated entry files live outside the package directory. Vite deduplicates `react` and `react-dom` so shared imports do not bring a second React runtime into the page. Server-side/CLI renderers retain their own dependency boundaries. This keeps production and browser tests on the same rendering semantics without changing application state, message, or tool contracts.

### D-webui-timeline-time-separators

[2026-09-27; updated 2026-10-02] A quiet centered timeline text row compares the next ordinary committed message’s valid `__meta.llmRequestTiming.startedAt`, falling back to `__meta.timestamp`, against the preceding message’s persisted `__meta.timestamp`. The marker displays that same selected next-message time, so a long request does not become an idle gap; the preceding baseline never uses its request start or substitutes `completedAt`. Structured CTX-BLOCKs still use only `__meta.contextBlock.rawStartTimestamp` for both their time and the following comparison, never their creation time or request timing. No ingress wrappers, reconstructed intervals, tool execution timing, or render time are read. The first eligible visible row shows its clock; other eligible rows show only their clock when the selected time differs from the preceding baseline by at least 60 seconds or crosses the browser’s local calendar date. A CTX-BLOCK without a valid range-start timestamp shows no time row and breaks adjacent comparison instead of falling back to its creation timestamp; missing or invalid predecessors can show only the next valid clock, without estimating a gap. English 24-hour `HH:mm` applies today, `MMM d, HH:mm` otherwise (year across years); the tooltip includes full date, seconds, and time zone. No elapsed suffix or countdown is shown. Tool responses and whole Event wrappers contribute their adjacent persisted timestamp but have no independent divider; an eligible next model call can safely split a historical group only without separating a paired call/result. A divider is a keyed sibling outside collapsed content with no viewport anchor; nested CTX, queued previews, and temporary/synthetic stream or optimistic rows add none. API/token/Seq badge behavior and stored backend timing data remain unchanged.

### D-webui-contiguous-reasoning-cards

[2026-10-01] Consecutive reasoning parts in one model message share one Reasoning card; the tag itself includes `×n` for multiple parts. Grouping follows original part adjacency, not the filtered visible list: text, system, tool, image, hosted activity, and unknown parts are barriers, and mixed-field parts retain their other visible output. Recognize a string `thinking` field (including empty), a typed reasoning-summary array, or known encrypted-reasoning metadata; generic provider metadata is not reasoning. Empty summaries still produce a real tag/card and count, without invented summary or visible encrypted content. The message's actual `reasoningTokens` appears once, on its first run, as `N tokens` with the Tool-duration text styling and `Message reasoning tokens` tooltip; zero is valid, absence adds no estimate. It is already included in output usage and is never added to totals again. Do not combine messages or borrow completion-suffix usage for an earlier committed prefix. Group disclosure and manual card height transitions remain unchanged; per-part DOM markers preserve exact Search ownership inside a merged card. This is presentation-only: canonical parts, replay, provider output order, history segmentation, and usage badges remain authoritative and unchanged.

### D-webui-chat-session-search

[2026-09-29] Chat offers pane-local Search over the current Session’s already-loaded committed top-level messages. Search opens from the Chat header or Ctrl/Cmd+F with a literal case-insensitive query, one current match counter, previous/next, and close; Enter, Shift+Enter, and Escape work inside its input. The browser Find shortcut is intercepted only when an actual Chat is active: in a split workbench only the focused active Chat registers the listener, while a standalone popup or embedded single Chat is active by default. It does not intercept Ctrl/Cmd+Shift+F, Alt combinations, composition, or a non-Chat active tab; repeating the shortcut focuses/selects the current query without duplicating Search. Opening Search builds a display-text projection once per history change and query edits only filter that projection; it performs no additional history or Archive requests and never counts queue previews, optimistic/streaming drafts, nested CTX archive content, image bytes, opaque reasoning, internal metadata, or non-text visual blocks. Ordinary Markdown is searched as rendered readable text; Tool arguments and complete expanded result text use the corresponding display formatters, not truncated preview content or a serialized card payload. An explicit jump temporarily reveals only the owning group/card (a CTX summary unclamps without fetching its archive), mounts an already-loaded older row only when that match or its needed group/call falls outside the current timeline window, detaches bottom-follow, and scrolls once with an exact-character browser text Range highlight. Forced disclosure does not alter manual expanded state or start the normal card-height animation; close/session replacement clears the instance’s highlight and never scrolls to the bottom. This pane-local feature adds no persisted query state, backend search index, or second scroll owner. The placeholder is “Search messages”; the search scope remains loaded messages while incomplete prefix loading continues.

### D-webui-product-language

[2026-08-16] Normal WebUI surfaces use concise product language rather than source comments, storage-path explanations, protocol details, or developer documentation. User actions, useful status, and actionable errors stay visible; implementation diagnostics belong in explicit debug or documentation surfaces instead of ordinary headings, subtitles, and help copy.

### D-webui-dynamic-base-path

All REST, SSE, WebSocket, download, Code, extension, and embedded URLs derive from the active deployment path/origin. Site-root assumptions are invalid.

### D-webui-workbench-shell

Chat, terminal, Agents, Setup, Search, Logs, and Code use one tab/pane workbench. Agents, Setup, Search, and Logs are singleton tabs; forced initial Setup is non-closable.

### D-webui-tab-popout

[2026-09-21] Every workbench tab exposes `Move to new window`. A successful synchronous browser popup opens a real same-origin single-leaf URL and then removes the source tab through the ordinary layout-only store action; a blocked popup or cancelled Setup/Agents unsaved-state warning leaves the source tab unchanged. Popup windows do not mount or persist the normal workbench, do not synchronize state back, and do not restore the source tab when closed. Chat relies only on its existing browser draft persistence and does not transfer page-memory files. Terminal popout requires an existing terminal ID, reattaches to that backend PTY, and never uses the terminal-delete close path. Code uses its existing standalone launch URL rather than moving the embedded iframe.

### D-webui-node-aware-launchers

[2026-08-10] Main-WebUI Code and terminal launch options use the authenticated public node summary and preserve explicit node identity. Terminal choices require an online `vscode-pty` service; Code choices require online `vscode-fs`, while Git remains optional. Offline, incompatible, and stale selected nodes stay visible and disabled in selectors and are never silently replaced with `master`. Selecting a different node in either main launcher dropdown resets that dropdown's draft path to the neutral absolute POSIX root `/`; this is selection-driven draft behavior only, with no per-node path cache or persistence before submission. A Chat header terminal uses that session's `currentNode` and cwd without showing a selector; desktop lower-pane reuse requires the same normalized node and cwd. The main Code launch target remains a browser-local preference, while session/tool/commit Code actions retain their own node targets. Code still uses the single persistent multi-root workbench defined by [D-code-persistent-workspace](../threads/code-integration.md#d-code-persistent-workspace), and all remote operations retain the fixed-service boundary in [D-code-fixed-remote-services](../threads/code-integration.md#d-code-fixed-remote-services).

### D-webui-session-stream-ownership

Mounted Chat owns per-session state and one logical session subscription. List consumers own logical subscriptions for loaded/current/open/watch rows. One page transport multiplexes them without turning list updates into an all-Session payload or substituting list projections for Chat runtime state. Physical transport and ordering are canonical in [D-webui-multiplexed-realtime](../threads/streaming-pipeline.md#d-webui-multiplexed-realtime); browser cache/query completeness is canonical in [D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).

### D-webui-history-bootstrap

[2026-08-02; updated 2026-09-06] The normal Chat bootstrap uses only the authenticated history route plus the per-session stream. The first registered load requests the newest 100 committed rows with the lightweight persistent system snapshot, queue preview, canonical session state, exact sequence frontier, history version, and guarded prefix length, then issues at most one request for that older prefix. The recent rows may paint immediately, but the context overview remains hidden until the complete committed history is present. Both responses share one request generation and replay newer committed stream rows before acceptance. The full debug-file payload is diagnostic data and must be fetched only after the user explicitly opens Debug, never as a mount or ordinary refresh dependency. Debug is a separately mounted modal lifetime: Open and each explicit Refresh fetch and serialize one immutable snapshot, while ordinary history, stream, model, and render updates neither reconstruct nor stringify it. Parsed payload, serialized text, copy state, request controller, and callbacks over those values remain modal-owned; Close, session replacement, and unmount abort or invalidate pending work and release that ownership, and reopening captures fresh state. The large Chat component must not own the serialized diagnostic text.

### D-webui-history-image-boundary

History, message streams, CTX expansion, and Debug expose authenticated deployment-relative image blob references rather than base64 or legacy paths. The cross-module persistence/provider/retention contract is canonical in [D-image-blob-canonical-lifecycle](../threads/image-blob-lifecycle.md#d-image-blob-canonical-lifecycle).

### D-webui-model-settings-navigation

The Chat model popup reuses the page-lifetime singleton `/api/models` result; opening it does not refresh model metadata. Its settings action activates the existing singleton Setup surface and requests focus for the Models YAML editor without creating a second instance: normal App uses the workbench callback, while Code-embedded Chat uses the nonce-bound fixed bridge to activate the Setup custom editor and deliver a one-shot focus signal. Neither path mutates the hash directly. Setup edits may require a page reload before cached choices change. This preserves workbench ownership, split-pane behavior, Code editor identity, and deployment subpaths.

### D-webui-settings-placement

[2026-09-06] The global sidebar settings menu is limited to the quick color-mode control plus Setup/reload/Logs actions. Logs behavior is canonical in [D-webui-logs-fixed-file-and-near-time](../units/webui-logs.md#d-webui-logs-fixed-file-and-near-time). Browser-local Input and Chat preferences belong in each Chat session header menu, where `Show user message metadata` defaults off and hides only already-classified lightweight direct-user metadata; attachment descriptor tags remain visible, and heavy/system-like cards are unchanged. All ordinary and embedded Chat roots read/write the same local-storage keys and consume `storage` updates without echo writes. Instance-wide browser name and tab icon controls belong below theme management in Setup's Appearance tab; each save sends only its changed field and merges only that field from the response, so overlapping opposite-field responses cannot restore a stale sibling value. Appearance is Setup's first/default tab, while explicit model-configuration navigation still activates and focuses Models. Moving controls does not change their browser-local versus server-backed authority.

### D-webui-removed-workspace

The former custom workspace/file browser remains removed. Persisted records are discarded; Code is the supported browser editing integration.

## Canonical ownership

Commit marker ownership: [D-code-model-commit-marker](../threads/code-integration.md#d-code-model-commit-marker). Chat follow ownership: [D-chat-user-follow-intent](../units/webui-chat.md#d-chat-user-follow-intent). Optimistic/history ordering ownership: [D-streaming-optimistic-message-identity](../threads/streaming-pipeline.md#d-streaming-optimistic-message-identity). YAML assistance ownership: [D-editor-local-yaml-assistance](../units/webui-editor.md#d-editor-local-yaml-assistance).
