# Module: WebUI

## Responsibility

Owns the browser application and WebUI-facing server surface: workbench/session navigation, chat/history streaming, message/tool rendering, composer/ASR, setup/settings, terminal client, and optional Code integration.

## Modules and units

- [webui-app](../units/webui-app.md) — authenticated entry, routing, restricted WebUI identity chat root, global administrator list state, embedded leaf roots, URL helpers, and Code frame host.
- [webui-session-list](../units/webui-session-list.md) — hierarchy, search, order, pinning, and drag behavior.
- [webui-nodes](../units/webui-nodes.md) — independent Node directory, status, onboarding and singleton/popup navigation.
- [webui-architecture-view](../units/webui-architecture-view.md) — agent/session architecture.
- [webui-chat](../units/webui-chat.md) — per-session history, logical realtime events, sending/commands, ASR, and viewport state.
- [webui-tasks](../units/webui-tasks.md) — read-only bounded task Table/Board, details, manual refresh and singleton/popup navigation.
- [webui-logs](../units/webui-logs.md) — bounded fixed-file logger history, live tail, and approximate date navigation.
- [webui-realtime](../units/webui-realtime.md) — one page-scoped multiplexed WebSocket, revisioned logical subscriptions, and server hub.
- [webui-chat-composer](../units/webui-chat-composer.md) — draft/input, autocomplete, attachments, and model controls.
- [WebUI timeline](./webui-timeline.md) — focused module for Timeline modes, pane-local Search, Reasoning, Conversation and Activity contracts, with navigation to the rendering units.
- [webui-workbench](../units/webui-workbench.md) — persisted tab/pane layout and compatibility normalization.
- [webui-workbench-content](../units/webui-workbench-content.md) — stable tab instances, shared slot geometry, current-pane headers/focus, and content error isolation.
- [webui-setup-view](../units/webui-setup-view.md), [webui-settings](../units/webui-settings.md), [settings menu](../units/webui-settings-menu.md).
- [webui-theme-system](../units/webui-theme-system.md) — versioned portable manifests, built-ins, browser-local registry/selection, semantic runtime, Setup management, and renderer adapters.
- [webui-terminal](../units/webui-terminal.md) — xterm browser client.
- [webui-editor](../units/webui-editor.md) (including the [shared Debug/Timeline JSON inspector](../units/webui-editor.md#d-editor-json-inspection)), [small components](../units/webui-small-components.md).
- [src-channels-webui](../units/src-channels-webui.md) — authenticated HTTP/WS/SSE/upload/setup/terminal routes.
- WebUI identity access is defined by `access.identities.<identityId>.surfaces.webui`; there is no persisted WebUI identity-token storage layer.
- Session list/state/history/settings routes and session update streams consume immutable SessionRuntime DTOs; destructive lifecycle and channel-attachment routes retain their explicit manager-owned coordination boundary.
- [VS Code Web routes](../units/src-vscode-web-routes.md) and [extensions](../units/vscode-web-extensions.md).

## URL and transport boundaries

- `API_BASE_PATH` is the current page pathname (without trailing slash) plus `/api`.
- REST and compatibility EventSource paths append to `API_BASE_PATH`; current list/Chat realtime uses one `makeWebSocketUrl` connection.
- `makeApiUrl` returns a URL object; `makeWebSocketUrl` changes its protocol to `ws:`/`wss:`.
- Code routes remove the `/api` suffix and append deployment-relative `/vscode-web/`.
- Main WebUI and the persistent Code frame validate exact origin plus window source. Nested Foxwarm leaf iframes post to their parent with `'*'`; the outer Code extension validates exact source plus channel/version/random nonce (not `event.origin`), then sends outer-to-inner messages to the exact leaf `frameOrigin`. These bridges are not API URL transport.
- Top-level tab popups use a separate versioned same-origin URL mode. They mount one Chat, terminal, Agents, Search, Logs, Tasks, Nodes, or Setup leaf without the workbench store; Code uses its existing standalone `/vscode-web/` URL. Popup target IDs may be URL parameters, but authentication tokens never are.
- Download and extension routes preserve reverse-proxy prefixes and do not assume site root.

## State ownership

- Each mounted Chat delegates history, queue, draft, and logical runtime subscription ownership to `useChatConversationSync`; rendering, viewport, search, settings requests, and ASR stay in Chat. The page realtime transport owns the physical connection.
- App/Sidebar/Architecture own their list data and logical subscriptions on the shared transport. Stream-triggered refreshes use fixed-delay, non-overlapping coalescing, while the session-list request gate remains latest-wins; the canonical contract is [D-webui-app-global-list-gate](../units/webui-app.md#d-webui-app-global-list-gate).
- Workbench store owns tab/pane/split layout; the shared [stable content host](../units/webui-workbench-content.md#d-workbench-stable-content) owns tab instances independently of that changing layout tree. Chat viewport state is ephemeral in-memory state keyed by canonical Session ID and history mode. Continuous display is separate from active context under [D-webui-continuous-chat-history](../threads/archive-and-recall.md#d-webui-continuous-chat-history).
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

- [Global history search viewer](../units/webui-history-search.md) — read-only Search workbench tab, exact message references, and independent result timelines; retrieval contract is [D-context-history-search-viewer](../threads/archive-and-recall.md#d-context-history-search-viewer).

- [streaming pipeline](../threads/streaming-pipeline.md)
- [context compaction and recall](../threads/context-compaction-and-recall.md)
- [image blob lifecycle](../threads/image-blob-lifecycle.md)
- [Code integration](../threads/code-integration.md)
- [node communication](../threads/node-communication.md)

## Compatibility

- Existing administrator instance tokens retain their authority; WebUI identity tokens do not create Sessions or Agents and do not grant agent tool permissions. The scoped browser contract is [D-webui-identity-session-scope](#d-webui-identity-session-scope).

- Supported legacy bracketed system/source history remains renderable.
- Old workbench `workspace`/`file` tabs are removed during read normalization; current writes never recreate them.
- Old `#agents`/`#architecture` and `#setup`/`#oobe` hashes hydrate current singleton system tabs.

## Design decisions

### D-webui-conversation-scroll-display

[2026-10-17] Conversation fixes the minimap off and native scrollbar on, independent of `historyMode`, without changing either stored preference. Detailed and Grouped continue to honor those preferences. Conversation's session menu shows Show minimap as disabled and off. The disabled minimap and its overlay are not mounted, and its column reservation is removed; Timeline/Composer shared widths and real native-gutter clearance remain unchanged.

### D-webui-shared-content-width

[2026-10-13] `index.css` owns the shared reading-column geometry: `--foxwarm-content-width` is 1100px, `.foxwarm-content-column` bounds and centers a padding-free column, and `--foxwarm-content-gutter` supplies 16px outer horizontal spacing. Non-full-width Chat Timeline, Composer, History's search/results column, and Tasks' Table/Board column use that contract; individual cards and modal dialogs retain their own padding and sizing. Composer always keeps the reading cap, even when Full width removes only Timeline's cap.

Desktop Chat reserves `--foxwarm-context-minimap-width` (32px) outside both columns before centering them, based on the effective minimap visibility and the owning Chat's 768px layout band. View-specific visibility follows [Conversation scroll display](#d-webui-conversation-scroll-display). Disabling the minimap removes both reservations; History and Tasks have no minimap reservation. Chat's existing content/scroller ResizeObserver publishes only the real native scrollbar gutter to `--foxwarm-chat-scrollbar-gutter`, so Composer also centers inside the scroller's usable width when a native scrollbar occupies space. Column sizing stays CSS-owned without another observer, React width state, or scroll owner. Tasks' filter row follows its main column, including the existing desktop inspector clearance; narrow details and New task remain independent modal layouts.

The focused `workbenchPreview.e2e.mjs` geometry case uses visible native scrollbars to check actual left/right edges through pane/window resizing and minimap changes, shared maximum widths, and narrow overflow containment. `tasksView.e2e.mjs` checks Table/Board widths and filter alignment beside the retained desktop inspector.

### D-webui-react18-runtime

[2026-09-19] The WebUI uses its locked React and ReactDOM 18.3.1 packages directly for JSX, hooks, and `createRoot`; Vite does not alias React to Preact. Browser component fixtures also resolve the WebUI's React 18 packages, including when their generated entry files live outside the package directory. Vite deduplicates `react` and `react-dom` so shared imports do not bring a second React runtime into the page. Server-side/CLI renderers retain their own dependency boundaries. This keeps production and browser tests on the same rendering semantics without changing application state, message, or tool contracts.

### D-webui-product-language

[2026-08-16] Normal WebUI surfaces use concise product language rather than source comments, storage-path explanations, protocol details, or developer documentation. User actions, useful status, and actionable errors stay visible; implementation diagnostics belong in explicit debug or documentation surfaces instead of ordinary headings, subtitles, and help copy.

### D-webui-dynamic-base-path

All REST, SSE, WebSocket, download, Code, extension, and embedded URLs derive from the active deployment path/origin. Site-root assumptions are invalid.

### D-webui-download-capabilities

[2026-10-17] Filesystem and image-blob downloads accept valid resource credentials **or** a valid resource-bound download signature. An invalid or expired signature never overrides valid resource credentials, and generic token-only or static-login middleware must not intercept a valid cookie-less download. `POST /api/download/sign` uses the existing administrator authorization boundary and checks the absolute file path before issuing a 15-minute URL; scoped WebUI identities cannot mint arbitrary filesystem grants. Global blob issuance (`POST /api/blobs/:blobId/download`) is administrator-only. Session blob issuance (`POST /api/sessions/:sessionId/blobs/:blobId/download`) reuses the existing Session scope and committed-reference checks for WebUI identities, including live alias/ownership resolution. A download capability cannot authorize issuance or unrelated routes.

The server derives a download-specific key from the active instance token using a domain-separated HMAC-SHA256, then signs the resource kind, file path or blob ID, optional Session route ID, download filename, preview option and expiry. Global blobs, Session blobs and arbitrary paths occupy distinct MAC namespaces; a grant cannot move between them or between Sessions. Verification uses constant-time MAC comparison and applies only to the download resource's GET/HEAD requests. No additional secret file or database is introduced, and the instance token never enters the URL. Ordinary restart retains grants; activating a different instance token invalidates prior grants. Expiry is checked when the request begins, with no timer interrupting an accepted stream.

Reply-file, expanded tool, image-viewer and unsafe-image attachment download actions obtain a fresh signed URL with their existing browser credentials immediately before handing it to the native browser downloader. Grants stay action-local rather than entering canonical messages or history. Existing unsigned authenticated thumbnails/previews, filename sanitization, raster-only inline MIME, HEAD behavior and deployment prefixes remain supported. Explicit blob downloads request attachment disposition without changing their safe MIME; local `blob:`/`data:` sources do not require signatures. Implementation and HTTP/browser evidence: [WebUI routes](../units/src-channels-webui.md) and [reply files](../units/webui-reply-files.md).

### D-webui-workbench-shell

Chat, terminal, Agents, Setup, Search, Logs, Tasks, Nodes, and Code use one tab/pane workbench. Agents, Setup, Logs, Tasks, and Nodes are singleton tabs; forced initial Setup is non-closable.

### D-webui-tab-popout

[2026-09-21] Every workbench tab exposes `Move to new window`. A successful synchronous browser popup opens a real same-origin single-leaf URL and then removes the source tab through the ordinary layout-only store action; a blocked popup or cancelled Setup/Agents unsaved-state warning leaves the source tab unchanged. Popup windows do not mount or persist the normal workbench, do not synchronize state back, and do not restore the source tab when closed. Chat relies only on its existing browser draft persistence and does not transfer page-memory files. Terminal popout requires an existing terminal ID, reattaches to that backend PTY, and never uses the terminal-delete close path. Code uses its existing standalone launch URL rather than moving the embedded iframe.

### D-webui-node-aware-launchers

[2026-08-10] Main-WebUI Code and terminal launch options use the authenticated public node summary and preserve explicit node identity. Terminal choices require an online `vscode-pty` service; Code choices require online `vscode-fs`, while Git remains optional. Offline, incompatible, and stale selected nodes stay visible and disabled in selectors and are never silently replaced with `master`. Selecting a different node in either main launcher dropdown resets that dropdown's draft path to the neutral absolute POSIX root `/`; this is selection-driven draft behavior only, with no per-node path cache or persistence before submission. A Chat header terminal uses that session's `currentNode` and cwd without showing a selector; desktop lower-pane reuse requires the same normalized node and cwd. The main Code launch target remains a browser-local preference, while session/tool/commit Code actions retain their own node targets. Code still uses the single persistent multi-root workbench defined by [D-code-persistent-workspace](../threads/code-integration.md#d-code-persistent-workspace), and all remote operations retain the fixed-service boundary in [D-code-fixed-remote-services](../threads/code-integration.md#d-code-fixed-remote-services).

### D-webui-session-stream-ownership

Mounted Chat owns per-session state and one logical session subscription. New input does not discard an active model draft ([send/draft contract](../units/webui-chat.md#d-webui-active-draft-send)); explicit Tool/group disclosure remains mounted-Session-local ([disclosure contract](../units/webui-tool-timeline.md#d-webui-tool-group-collapse)). List consumers own logical subscriptions for loaded/current/open/watch rows. One page transport multiplexes them without turning list updates into an all-Session payload or substituting list projections for Chat runtime state. Physical transport and ordering are canonical in [D-webui-multiplexed-realtime](../threads/streaming-pipeline.md#d-webui-multiplexed-realtime); browser cache/query completeness is canonical in [D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).

### D-webui-history-bootstrap

[2026-08-02; updated 2026-09-06] The normal Chat bootstrap uses only the authenticated history route plus the per-session stream. The first registered load requests the newest 100 committed rows with the lightweight persistent system snapshot, queue preview, canonical session state, exact sequence frontier, history version, and guarded prefix length, then issues at most one request for that older prefix. The recent rows may paint immediately, but the context overview remains hidden until the complete committed history is present. Both responses share one request generation and replay newer committed stream rows before acceptance. The full debug-file payload is diagnostic data and must be fetched only after the user explicitly opens Debug, never as a mount or ordinary refresh dependency. Debug is a separately mounted modal lifetime: Open and each explicit Refresh fetch and serialize one immutable snapshot, while ordinary history, stream, model, and render updates neither reconstruct nor stringify it. Parsed payload, serialized text, copy state, request controller, and callbacks over those values remain modal-owned; Close, session replacement, and unmount abort or invalidate pending work and release that ownership, and reopening captures fresh state. The large Chat component must not own the serialized diagnostic text.

### D-webui-history-image-boundary

History, message streams, CTX expansion, and Debug expose authenticated deployment-relative image blob references rather than base64 or legacy paths. The cross-module persistence/provider/retention contract is canonical in [D-image-blob-canonical-lifecycle](../threads/image-blob-lifecycle.md#d-image-blob-canonical-lifecycle).

### D-webui-model-settings-navigation

The Chat model popup reuses the page-lifetime singleton `/api/models` result; opening it does not refresh model metadata. Its settings action activates the existing singleton Setup surface and requests focus for the Models YAML editor without creating a second instance: normal App uses the workbench callback, while Code-embedded Chat uses the nonce-bound fixed bridge to activate the Setup custom editor and deliver a one-shot focus signal. Neither path mutates the hash directly. A Models focus request is one-shot: the owner that receives it clears the request after its SetupView consumes it, so later remounts, tab switches, or ordinary Setup activations do not replay focus; each explicit picker request switches to Models and focuses again. A successful Models save and the picker’s explicit Refresh action invalidate only the current JavaScript context’s model cache and notify mounted Chat consumers to load the new shared result. Failed saves preserve the cache; ASR and command caches are unaffected. Existing latest-request gates prevent pre-refresh responses from replacing newer options. Separate popup windows and Code leaf iframes do not synchronize these caches; their Chat pickers can explicitly Refresh. This preserves workbench ownership, split-pane behavior, Code editor identity, and deployment subpaths.

### D-webui-settings-placement

[2026-09-06] The global sidebar settings menu is limited to the quick color-mode control plus Setup/reload/Logs actions. Logs behavior is canonical in [D-webui-logs-fixed-file-and-near-time](../units/webui-logs.md#d-webui-logs-fixed-file-and-near-time). Browser-local Input and Chat preferences belong in each Chat session header menu, where `Show user message metadata` defaults off and hides only already-classified lightweight direct-user metadata; attachment descriptor tags remain visible, and heavy/system-like cards are unchanged. All ordinary and embedded Chat roots read/write the same local-storage keys and consume `storage` updates without echo writes. Instance-wide browser name and tab icon controls belong below theme management in Setup's Appearance tab; each save sends only its changed field and merges only that field from the response, so overlapping opposite-field responses cannot restore a stale sibling value. Appearance is Setup's first/default tab, while explicit model-configuration navigation still activates and focuses Models. Moving controls does not change their browser-local versus server-backed authority.

### D-webui-removed-workspace

The former custom workspace/file browser remains removed. Persisted records are discarded; Code is the supported browser editing integration.

### D-webui-identity-session-scope

[2026-10-08; updated 2026-10-10] A `webui` access identity grants browser chat, history, live events, and attachment uploads within `access.identities.<identityId>.surfaces.webui.sessions`. Each entry is either an exact Session ID or `<agent>/*` with an ASCII-letter/digit/underscore/hyphen Agent name; bare `*` and other wildcard patterns are rejected. Exact bindings resolve committed aliases and continue following the same Session across moves. Agent scopes cover that Agent's current and future Sessions by actual catalog ownership, including the unprefixed IDs of the `main` Agent; they never compare ID prefixes. Requested aliases resolve to the current canonical Session before ownership is checked, so an old alias under a scoped Agent cannot authorize a Session moved out of that Agent. Missing or ambiguous references do not grant access. Auth and restricted Chat selection lists project currently accessible canonical IDs on each request, not a permanent login-time expansion. HTTP reads and attachment/message ingestion recheck the same scope at their existing authorization boundaries; WebSocket and compatibility SSE output also recheck current scope before Session payloads are sent, ending stale canonical streams after moves. Other WebUI routes and streams remain administrator-only; the restricted identity root cannot mount workbench, popup, embedded, Setup, Code, terminal, sidebar, model, debug, or management surfaces. WebUI identity messages reject leading slash and mention-prefixed slash commands before router dispatch, and uploads bind the file to the same identity and Session before ingestion. Existing administrator instance-token behavior is unchanged. The identity grants no agent execution/tool permissions: tool results in an accessible Session remain ordinary unredacted chat content. Browser image blobs require both an accessible Session and a reference in its active history or a sequence-proven effective Archive message; arbitrary filesystem access and path-download signature issuance remain administrator-only; scoped blob downloads use the resource-bound capabilities described above.

## Canonical ownership

Commit marker ownership: [D-code-model-commit-marker](../threads/code-integration.md#d-code-model-commit-marker). Chat follow ownership: [D-chat-user-follow-intent](../units/webui-chat.md#d-chat-user-follow-intent). Optimistic/history ordering ownership: [D-streaming-optimistic-message-identity](../threads/streaming-pipeline.md#d-streaming-optimistic-message-identity). YAML assistance ownership: [D-editor-local-yaml-assistance](../units/webui-editor.md#d-editor-local-yaml-assistance).

Mobile presentation: [mobile shell](../threads/webui-mobile-shell.md). User attachments: [attachment presentation](../threads/webui-attachment-presentation.md).

- [Reply file grids](../units/webui-reply-files.md) expose successful deliveries outside process disclosure.
