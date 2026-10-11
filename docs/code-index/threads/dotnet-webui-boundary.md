# Thread: .NET WebUI HTTP/realtime boundary

## Producer to consumer path

```text
Browser WebUI fetch/WebSocket/PTY/Code request
  -> HttpServer auth/prefix/static middleware
  -> WebUIChannel route registration and DTO validation
  -> SessionManager/SessionRuntime/TaskService/CodeWorkbench/TerminalRouter
  -> JSON authority/catalog/task/terminal/Code durable or live boundary
  -> WebUiRealtime event/revision
  -> React units merge committed response with optimistic state
```

- **Producer:** React units issue deployment-relative API/WebSocket requests; realtime reconnect/ack code subscribes to host revisions. Browser optimistic composer/list state is not a durable write.
- **Owner:** `HttpServer` performs normal token/cookie auth checks and route/static composition. `WebUIChannel` owns DTOs and route handlers; feature services own Session/task/Code/terminal/image semantics.
- **Durable boundary:** Session routes delegate to exact owner/save-lane/authority/catalog; task routes delegate `TaskService`; file/image routes delegate `FileDelivery`/`ImageBlobStore`; Code and terminal routes delegate `CodeWorkbench`/`TerminalRegistry`; realtime publishes authenticated event envelopes/revisions after service state changes.
- **Consumers:** React App shell, chat/composer/timeline, session-navigation, TasksView, workbench, terminal, settings, and theme units. Each keeps optimistic/local state distinct from committed host payloads.

## Auth and route order

Static WebUI and state-changing routes are served only after normal host auth; `POST /api/auth` is the token exchange. Authenticated `GET /api/auth/session` returns `{ role: 'admin' }` for the current full-access instance-token host. Prefix/base-path handling is deployment-relative. Route handlers validate request IDs/limits before invoking manager/runtime services and translate committed/accepted/partial failures into explicit HTTP payloads.

## Realtime and history

`WebUiRealtime` carries Session lifecycle, message/tool stream, task, list/presentation, terminal, and Code events with revision/ack semantics. A streamed delta is not automatically active JSON history; the Session turn/save path determines when canonical history is committed. Browser replay/list units use bounded cursors and catalog projections, not Archive reconstruction.

## Current gaps

The .NET channel has real routes for current tasks/terminal/files/images/history; Vector-backed history/admission remains `VECTOR_DISABLED` and remote Node/Worker routes are not claimed as fully connected to this Main. Root package start/build still targets TypeScript Main even though this .NET host is the active replacement architecture.

The current React entry point requests `GET /api/auth/session` before mounting any normal, popup, or embedded root. It expects `{ role: 'admin' }` for the administrator app or a verified scoped WebUI identity response for the restricted root. The .NET host implements the authenticated administrator response, so successful instance-token login allows the merged client to mount the administrator app. Restricted WebUI identities remain explicitly deferred and are not accepted or represented as supported.

## Canonical units and tests

- [Host runtime](../units/host-runtime.md)
- [WebUI channel registration](../units/dotnet-webui-core.md)
- [WebUI history/list](../units/dotnet-webui-history-list.md)
- [WebUI files/images](../units/dotnet-webui-files-images.md)
- [WebUI tasks/relations](../units/dotnet-webui-tasks-relations.md)
- [WebUI deletion/terminal](../units/dotnet-webui-lifecycle-terminal.md)
- [WebUI realtime](../units/webui-realtime.md)
- [React WebUI module](../modules/webui.md)
- `WebUiStartupTests`, `WebUiUploadedFilesTests`, `WebUiRealtimeRevisionTests`, `CodeRoutesTests`, and Session/catalog/task tests.
