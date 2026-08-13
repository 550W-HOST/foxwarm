# Unit: src-channels-webui

Files: src/channels/webuiChannel.ts, src/channels/webuiSessionsRoute.test.ts, src/channels/webuiSendFile.test.ts, src/channels/webuiModelsDiagnostics.test.ts, src/channels/webuiNodesRoute.test.ts, src/channels/webuiTerminalsRoute.test.ts, src/channels/webuiTerminalStream.test.ts
Secondary files: src/webuiSettings.ts, src/webuiSettings.test.ts, src/vscodeWebRoutes.ts

## Purpose

Implements the WebUI channel's HTTP, SSE, upload/download, setup, model, channel, session, and browser-terminal routes. It translates browser actions into the message router and immutable SessionRuntime DTO operations used by other external interfaces. Destructive lifecycle and channel-attachment flows intentionally retain direct session-manager coordination.

`src/webuiSettings.ts` is primarily documented by [webui-settings](./webui-settings.md). `src/vscodeWebRoutes.ts` is documented by [VS Code Web routes](./src-vscode-web-routes.md).

## Key exports

- `WebUIChannel` — channel implementation and WebUI route registrar.
- `buildWebUiSessionState(sessionDto)` — canonical single-session runtime/model/effort/node/cwd payload shared by list, history, and streams.
- `buildWebUiModelsPayload(currentModel?)` — model selector capability payload including virtual routing metadata and allowed/default effort presentation.
- `buildQueuedPreviewMessages(queue)` — bounded render-only queue previews.
- `broadcastMessage`, `broadcastSessionStateUpdate`, and `broadcastSessionListUpdate` — per-session and global SSE delivery.
- `getModelsSetupDiagnostics(modelsPath?)` — structured concrete/virtual setup diagnostics.

## Route groups

- Authentication and setup status.
- Session list, history, create, update, fork, move, pin, model, cwd, and message routes.
- Fixed bounded `/api/session-list/sidebar`, `/children`, `/by-id`,
  `/architecture`, `/descendants/:sessionId`, and `/search` query routes.
- Per-session SSE plus the independent global session-list stream.
- File upload and authenticated download.
- Authenticated content-addressed image blob delivery.
- Model/provider and channel configuration, validation, and connectivity tests.
- ASR and messaging-platform setup helpers.
- Browser terminal REST/WebSocket routes.
- Authenticated public-safe node/service summaries for WebUI launch selectors.
- Read-only one-layer CTX-BLOCK expansion.
- Registration of the independent optional Code routes.

## Dependencies

- `messageRouter` for inbound browser messages and commands.
- `sessionRuntime` for cloned list/state/history projections, enqueue, settings, controls, and history/list/state events.
- `sessionDeletion` for shared deletion orchestration; `sessionManager` for fork/move/create coordination, relations, channel attachments, and compatibility-only live-object routes.
- `setupConfig`, `config`, and model resolution for validated configuration APIs.
- `channelFiles` for upload persistence and model-facing file descriptions.
- `httpServer` for authenticated routes and WebSocket upgrades.
- `terminalManager` and terminal routing for browser PTYs.
- Node registry and runtime manager for approved-node metadata, online state, and versioned service summaries.
- `webuiSettings` for instance branding.
- `vscodeWebRoutes` for optional Code integration.

## Behavior

- `GET /api/sessions` returns canonical `runtimeState` while retaining documented legacy busy fields for compatibility.
- `/api/session-list/*` returns versioned bounded projections over the Main
  catalog: mode-aware keyset roots/flat rows, compound bounded child seeks, forced
  focus paths, exact/alias batches, Architecture summaries, descendant preview,
  and explicit JavaScript-compatible search. It does not hydrate semantic
  history or replace the legacy all-list route.
- Sidebar focus is a repeatable capped `focusSessionId` query (commas remain
  literal ID content), with complete chunked ancestor context. New route DTOs
  reject unknown keys, wrong scalar/container types, and out-of-bound values;
  stable validation errors return HTTP 400. Architecture uses the real
  cross-agent forest contract rather than Sidebar pinned elevation.
- Session list, agent-tree, state, history, model, child-model, cwd, and display-name routes use SessionRuntime DTO calls. The existing model and child-model POST routes accept property-presence model/effort pairs and return canonical raw/effective/capability state from the exact owner; legacy `clear` remains model-only. History canonicalization rejects a concurrent history replacement retryably rather than overwriting newer live messages.
- `GET /api/sessions/:id/history` returns committed messages, the lightweight `persistentMemorySnapshot`, a separate bounded `queuedMessages` preview, queue length, and a canonical session snapshot. Queue previews never become committed history; normal Chat bootstrap does not need the full debug-file route.
- History, persisted-message SSE, one-layer CTX-BLOCK expansion, and explicit Debug payloads recursively replace canonical image refs with deployment-relative `/blobs/:blobId` API paths and never expose base64 or legacy image paths, including nested function responses and non-history Debug structures. Unmaterializable legacy images become explicit unavailable metadata without discarding surrounding business fields. `GET /api/blobs/:blobId` is authenticated, immutable-cacheable, traversal-safe, and inline-serves only safe raster formats; other formats are attachment-only with `nosniff`. Canonical contract: [image blob lifecycle](../threads/image-blob-lifecycle.md).
- `GET /api/sessions/:id/state` returns only `{ session: buildWebUiSessionState(session) }` (or 404). Chat uses this lightweight authenticated probe only when EventSource fails before opening, so reconnect existence checks never download history.
- `POST /api/sessions/:id/message` accepts a bounded optional browser `clientMessageId` and forwards it as routing metadata without adding it to model-visible parts.
- Each per-session SSE connection sends an immediate SessionRuntime state snapshot, then cloned history/state events plus router-owned transient stream and deletion updates for that session.
- The global SSE stream sends catalog invalidation without an all-row payload. A client may subscribe with capped repeated `sessionId` parameters; connection sends immediate bounded projections for matching exact/alias rows, and later state/deletion events send `session-list-delta` only for subscribed canonical IDs. This supports loaded/current/open/watch rows without recreating a complete browser mirror.
- While an exact global-SSE snapshot is being prepared, newer subscribed state/deletion deltas are buffered latest-per-ID; the wire always emits the initial snapshot first, then those newer deltas, then any buffered versioned invalidation. Disconnect cleanup is installed before the awaited snapshot so closed clients cannot be written, scheduled, or retained afterward. A no-ID stream remains a supported invalidation-only subscription.
- `POST /api/session-list/descendant-activity` accepts at most 100 exact/unique-alias row IDs and returns authoritative busy-descendant counts from one active-ID ancestor projection. Current exact local/Worker busy and idle projections override catalog candidates, stale Worker projections are excluded, and current volatile active-only IDs are then added. Cycles terminate and never count a root as its own descendant. It is the bounded ordinary badge path; exact lifecycle dialogs keep using the recursive descendant preview.
- Session ordering and pinning update the shared session metadata index rather than rewriting history snapshots.
- Archive accepts optional `includeDescendants` only for archive-to-true and returns matched/changed IDs and counts. Delete delegates to the shared Main-owned lifecycle orchestrator. It accepts optional `includeDescendants`, recomputes and claims the canonical subtree, preflights every selected session for channel/busy blockers, revalidates graph/channel/activity state, deletes recursively deepest-first, and reports partial progress on unexpected failures. Single-session deletion claims and detaches direct survivors before deleting the root. Canonical semantics: [D-lifecycle-descendant-actions](../threads/session-lifecycle.md#d-lifecycle-descendant-actions).
- Named session and agent-main creation return HTTP 409 with `code: "SESSION_ID_ARCHIVED"` when the requested internal ID belongs to an archived deleted lifetime. Canonical semantics: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
- CTX-BLOCK expansion delegates to the read-only archive helper and never queues, saves, or broadcasts session mutations.
- The model-test endpoint treats request exceptions as failed HTTP results rather than scanning successful model text for an `Error:` prefix.
- Setup routes are normal authenticated WebUI routes: `GET /api/setup/status`; `POST /api/setup/models`, `/api/setup/models/test`, `/api/setup/config`, `/api/setup/channels`, `/api/setup/weixin/login/start`, and `/api/setup/weixin/login/wait`. OOBE is reported when the models file is absent; there is no separate guest/admin role API at these routes.
- Setup diagnostics and both raw and retained structured model writes resolve the active models file through the data-directory-only path contract in [D-config-models-data-path](./src-config.md#d-config-models-data-path).
- Model setup diagnostics expose virtual strategy/targets/failover values, while session model selection remains the virtual key. `/api/models` exposes ordered allowed efforts and a concrete default or virtual `null`; session projections expose raw/effective current and child effort without materializing defaults. Canonical backend contract: [D-model-routing-effort](../threads/model-routing.md#d-model-routing-effort).
- The former custom workspace filesystem routes remain removed; authenticated file download remains available for tool/file affordances.
- `GET /api/nodes` returns `master` plus approved remote node IDs, public labels/types, current online state, last-seen time, and only the allowlisted Code/terminal launcher service versions. Pending pairings, credentials, token hashes, model-tool schemas, other backend services, and private configuration are not part of this DTO.
- `sendFile` is a channel no-op because the browser consumes file information through tool result metadata and authenticated download routes.
- After terminal-stream authentication and successful PTY attachment, the route sends a WebSocket protocol ping every 30 seconds while the socket remains open. Close or error clears the unreferenced timer and detaches the browser client without closing the PTY; only the existing explicit terminal-close message/API kills it. This is transport keepalive, not an application JSON message or terminal lifecycle timeout. Canonical semantics: [D-code-terminal-lifecycle](../threads/code-integration.md#d-code-terminal-lifecycle).

## Compatibility

- List and history payloads retain documented legacy busy fields while current clients prefer `runtimeState`.
- Persisted session-list presentation metadata may be lost when the metadata index must be rebuilt from history; it is intentionally not duplicated into history files.

## Design decisions

### D-webui-channel-queue-preview

Queued content is returned as a separate render-only array in the normal history payload. It is not a second queue API and is never mixed into committed messages.

### D-webui-channel-workspace-removal

Removed browser workspace routes stay removed. File downloads support explicit tool/file actions but do not recreate a general browser filesystem editor.

## Canonical ownership

Per-session versus global stream ownership is canonical in [D-webui-session-stream-ownership](../modules/webui.md#d-webui-session-stream-ownership). History/debug bootstrap is canonical in [D-webui-history-bootstrap](../modules/webui.md#d-webui-history-bootstrap). Optimistic identity delivery is canonical in [D-streaming-optimistic-message-identity](../threads/streaming-pipeline.md#d-streaming-optimistic-message-identity). Cross-module delivery flow: [streaming pipeline](../threads/streaming-pipeline.md).
