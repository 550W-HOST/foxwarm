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

The .NET channel has real routes for current tasks/terminal/files/images/history and connected external Node onboarding, ordinary tools, exec/completion, file consumers, Code/PTY and exec-only Shell HTTP. The connected Node contract and remaining Worker boundary belong to [Remote Node compatibility](./remote-node-compatibility.md#net-external-node-integration). Vector-backed history/admission remains `VECTOR_DISABLED`. Root package start/build still targets TypeScript Main even though this .NET host is the active replacement architecture.

The current React entry point requests `GET /api/auth/session` before mounting any normal, popup, or embedded root. It expects `{ role: 'admin' }` for the administrator app or a verified scoped WebUI identity response for the restricted root. The .NET host implements the authenticated administrator response, so successful instance-token login allows the merged client to mount the administrator app. Restricted WebUI identities remain explicitly deferred and are not accepted or represented as supported.

The merged React Node picker now uses real authenticated `GET /api/sessions/{id}/nodes` and `POST /api/sessions/{id}/node` handlers. Directory reads use catalog/topology; selection uses the exact owner/save lane with cwd retention. History/realtime/composer DTOs expose committed Node/cwd, and the original App is qualified with owned official Node clients. The [WebUI contract unit](../units/dotnet-webui-core.md) maps these consumers. The current Setup omits Authorizations; the browser callback and implemented [instance-shared outbound MCP OAuth](../units/dotnet-mcp-oauth.md) administrator routes/grant lifecycle remain supported; inbound MCP and restricted identities remain deferred.

## Merged original-App qualification

`experimentHostWorkbenchParity.e2e.mjs` runs a disposable normal host with real file-token login, actual Agent/Session creation, local scripted provider requests and the built original App. It checks request/tool timing and result-first Conversation rendering, existing task/status/cumulative usage consumers, Debug/Timeline JSON dialogs, stable Chat content across splits, History draft/submission separation with the real `VECTOR_DISABLED` response, docked/restored local PTYs, and the ordinary Code launch preference. Optional official Code-OSS assets additionally exercise persistent embedded workbench, actual filesystem saves, SCM commit/diff webviews and the terminal extension. Prepared asset version evidence is in [Code services](../units/code-services.md#asset-adaptation-and-version-evidence); the fixture does not infer version parity from a pin.

Targeted merged-client fixtures independently cover pane/iframe/terminal identity, pending History submission behavior, inspector immutability/model disposal and Conversation timing disclosure. These controlled browser fixtures complement, rather than replace, real normal-host/provider qualification. Existing Node, OAuth and Anthropic E2Es remain separate consumers.

The built Vite 8/Rolldown client keeps its recovery script/styles inline in `index.html`; external scripts, styles and lazy chunks remain deployment-relative files under `assets/`. The existing host serves that index with no-store and the original administrator login/prefix boundary, without a new route or endpoint. `experimentHostLegacyNodeProjection.e2e.mjs` qualifies a real prefix/login, browser-only missing root-chunk fault and explicit reload recovery alongside retained Session projection. `experimentHostNodeConsumers.e2e.mjs` uses a normal host, real CLI/Shell peers, the Nodes workbench directory and onboarding dialog, and exact composer Node/cwd consumers. The output must still be supplied as a complete built WebUI directory at the existing host/publish boundary; a C# build alone does not build or deploy client assets.

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
