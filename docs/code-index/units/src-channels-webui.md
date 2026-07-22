# Unit: src-channels-webui

Files: src/channels/webuiChannel.ts, src/channels/webuiSessionsRoute.test.ts, src/channels/webuiSendFile.test.ts
Secondary files: src/webuiSettings.ts, src/webuiSettings.test.ts, src/vscodeWebRoutes.ts

## Purpose

Implements the WebUI channel's HTTP, SSE, upload/download, setup, model, channel, session, and browser-terminal routes. It translates browser actions into the same message router and session-manager operations used by other interfaces.

`src/webuiSettings.ts` is primarily documented by [webui-settings](./webui-settings.md). `src/vscodeWebRoutes.ts` is documented by [VS Code Web routes](./src-vscode-web-routes.md).

## Key exports

- `WebUIChannel` — channel implementation and WebUI route registrar.
- `buildWebUiSessionState(session)` — canonical single-session runtime/model/node/cwd payload shared by list, history, and streams.
- `buildQueuedPreviewMessages(queue)` — bounded render-only queue previews.
- `broadcastMessage`, `broadcastSessionStateUpdate`, and `broadcastSessionListUpdate` — per-session and global SSE delivery.

## Route groups

- Authentication and setup status.
- Session list, history, create, update, fork, move, pin, model, cwd, and message routes.
- Per-session SSE plus the independent global session-list stream.
- File upload and authenticated download.
- Model/provider and channel configuration, validation, and connectivity tests.
- ASR and messaging-platform setup helpers.
- Browser terminal REST/WebSocket routes.
- Read-only one-layer CTX-BLOCK expansion.
- Registration of the independent optional Code routes.

## Dependencies

- `messageRouter` for inbound browser messages and commands.
- `sessionManager` for session state, persistence, relations, runtime state, and model/node/cwd updates.
- `setupConfig`, `config`, and model resolution for validated configuration APIs.
- `channelFiles` for upload persistence and model-facing file descriptions.
- `httpServer` for authenticated routes and WebSocket upgrades.
- `terminalManager` and terminal routing for browser PTYs.
- `webuiSettings` for instance branding.
- `vscodeWebRoutes` for optional Code integration.

## Behavior

- `GET /api/sessions` returns canonical `runtimeState` while retaining documented legacy busy fields for compatibility.
- `GET /api/sessions/:id/history` returns committed messages, a separate bounded `queuedMessages` preview, queue length, and a canonical session snapshot. Queue previews never become committed history.
- Each per-session SSE connection sends an immediate state snapshot, then message, stream, runtime, queue, and deletion updates for that session.
- The global SSE stream is reserved for Sidebar, Architecture, and other list-wide consumers.
- Session ordering and pinning update the shared session metadata index rather than rewriting history snapshots.
- Named session and agent-main creation return HTTP 409 with `code: "SESSION_ID_ARCHIVED"` when the requested internal ID belongs to an archived deleted lifetime. Canonical semantics: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
- CTX-BLOCK expansion delegates to the read-only archive helper and never queues, saves, or broadcasts session mutations.
- The model-test endpoint treats request exceptions as failed HTTP results rather than scanning successful model text for an `Error:` prefix.
- Setup routes are normal authenticated WebUI routes: `GET /api/setup/status`; `POST /api/setup/models`, `/api/setup/models/test`, `/api/setup/config`, `/api/setup/channels`, `/api/setup/weixin/login/start`, and `/api/setup/weixin/login/wait`. OOBE is reported when the models file is absent; there is no separate guest/admin role API at these routes.
- The former custom workspace filesystem routes remain removed; authenticated file download remains available for tool/file affordances.
- `sendFile` is a channel no-op because the browser consumes file information through tool result metadata and authenticated download routes.

## Compatibility

- List and history payloads retain documented legacy busy fields while current clients prefer `runtimeState`.
- Persisted session-list presentation metadata may be lost when the metadata index must be rebuilt from history; it is intentionally not duplicated into history files.

## Design decisions

### D-webui-channel-queue-preview

Queued content is returned as a separate render-only array in the normal history payload. It is not a second queue API and is never mixed into committed messages.

### D-webui-channel-workspace-removal

Removed browser workspace routes stay removed. File downloads support explicit tool/file actions but do not recreate a general browser filesystem editor.

## Canonical ownership

Per-session versus global stream ownership is canonical in [D-webui-session-stream-ownership](../modules/webui.md#d-webui-session-stream-ownership). Cross-module delivery flow: [streaming pipeline](../threads/streaming-pipeline.md).
