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

Static WebUI and state-changing routes are served only after normal host auth; `POST /api/auth` is the token exchange. Authenticated `GET /api/auth/session` returns the administrator or verified scoped WebUI role and feature projection. The instance token retains full selected-Session authority; scoped identities use the explicit browser allowlist and live catalog scope in [shared access](../units/dotnet-access-identities.md). Marked path/global/Session-blob GET/HEAD endpoints additionally accept an independent verified download capability; issuance and unrelated APIs stay protected. See [file/image routes](../units/dotnet-webui-files-images.md). Prefix/base-path handling is deployment-relative. Route handlers validate request IDs/limits before invoking manager/runtime services and translate committed/accepted/partial failures into explicit HTTP payloads.

## Realtime and history

`WebUiRealtime` carries Session lifecycle, message/tool stream, task, list/presentation, terminal, and Code events with revision/ack semantics. A streamed delta is not automatically active JSON history; the Session turn/save path determines when canonical history is committed. Browser replay/list units use bounded cursors and catalog projections, not Archive reconstruction. The separate continuous-history display route reads bounded effective original Archive pages under the ordinary snapshot upper bound; it never supplies active authority. See [history routes](../units/dotnet-webui-history-list.md).

## Current gaps

The .NET channel has real routes for current tasks/terminal/files/images/history and connected external Node onboarding, ordinary tools, exec/completion, file consumers, Code/PTY and exec-only Shell HTTP. The connected Node contract belongs to [Remote Node compatibility](./remote-node-compatibility.md#net-external-node-integration); excluded hosting/lifecycle platforms are listed in [delivery scope](../overview.md#d-dotnet-delivery-scope). Vector-backed history/admission follows the configured [Vector owner](../units/vector-owner.md); disabled configuration remains explicitly `VECTOR_DISABLED`. Root package startup and delivery build select managed Main; the TypeScript Main remains an explicit reference build.

Managed Main supplies the [artifact producer, immutable store and authenticated Session routes](../units/dotnet-artifacts.md) consumed by the unchanged [interactive artifact client](./webui-artifacts.md). The maintained application artifact scenario stays enabled and exercises actual publication and reload; selected renderer or published-core checks are not substitutes for the complete application lane. The independent [managed Main Logs producer](../units/dotnet-webui-logs.md) supplies the fixed-file history/time route, real Main diagnostics and file-backed topic on the existing realtime connection.

The current React entry point requests `GET /api/auth/session` before mounting any normal, popup, or embedded root. It expects `{ role: 'admin' }` for the administrator app or a verified scoped WebUI identity response for the restricted root. The .NET host supplies both role responses: instance-token login mounts the administrator App and configured WebUI identities mount the original restricted chat root. The complete shared map is validated; [ordinary inbound MCP](../units/dotnet-inbound-mcp.md) owns declared MCP surfaces and their live installation, while [the access unit](../units/dotnet-access-identities.md) owns shared identity installation and selective revocation.

The merged React Node picker now uses real authenticated `GET /api/sessions/{id}/nodes` and `POST /api/sessions/{id}/node` handlers. Directory reads use catalog/topology; selection uses the exact owner/save lane with cwd retention. History/realtime/composer DTOs expose committed Node/cwd, and the original App is qualified with owned official Node clients. The [WebUI contract unit](../units/dotnet-webui-core.md) maps these consumers. The current Setup omits Authorizations; the browser callback and implemented [instance-shared outbound MCP OAuth](../units/dotnet-mcp-oauth.md) administrator routes/grant lifecycle remain supported; inbound MCP has its independent declared surface and external authority; scoped WebUI identities use the shared live access snapshot.

### Runtime, controls, notices, and communications

The .NET exact owner supplies the shared [runtime presentation](./session-runtime-presentation.md) shape to live/reconnect events, history bootstrap, and bounded local Session-list/Architecture overlays. Resolved tool identity/preview/batch facts come from authorized dispatch; physical request attempts clear normal or independent compact retry projections. Stopping is visible only while busy. Compaction publishes its exact operation and planning/enqueueing/ready/committing stages independently of foreground work. A required planning wait temporarily owns the foreground compact phase; exact leases prevent older cleanup from clearing newer work. These facts are transient, not new scheduler states or persisted status records.

`/message` validates optional `controlRequestId` independently of `clientMessageId`. Supported structured controls publish correlated `session-control-feedback` events (`accepted`, `noop`, or `error`) and fresh owner state without adding command cards. Continue signals admission after the ordinary processor validates continuation and claims busy; Stop does not await the whole foreground drain before acknowledging. Compact cancellation similarly acknowledges its cancellation request separately from settlement. Actual busy/stopping/queue/compact state, not HTTP acknowledgement, settles the incoming UI. The shared transient `runtimeState.processing` projection additionally withholds Continue until exact-owner foreground cleanup ends, without extending the persisted busy checkpoint. Unsupported recognized syntax receives correlated error feedback rather than silently timing out.

Typed `system-event` notices are trusted display-only canonical messages. Safe ordinary and owner-applied compact failures append through the existing save lane; unsafe authority/identity paths publish temporary typed messages instead. Exact-owner error identity and final retry-tail recognition suppress duplicate cards. Cancellation, shutdown and incompatible compact snapshots are not new failures. Provider reconstruction continues to exclude display-only messages and function-response display metadata.

Successful builtin Session sends capture the canonical destination and bounded authored body separately from semantic handoff receipts. Direct/unified calls persist `sessionMessages`; ordinary ToolScript host calls attach `sessionMessage` only to their actual completed subcall. Nested runtimes do not replace outer slice presentation. MCP/result data and script text/stdout cannot fabricate these receipts. Incoming inter-agent envelopes, actual delivery count and afterSend/wait/finish semantics remain unchanged.

The standalone generated login retains the existing packaged `public/login.html` and [frontend cookie ownership](../units/webui-login.md#d-login-cookie-ownership); native Desktop login belongs to [host startup](../units/host-runtime.md#desktop-boundary). History preparation/navigation use existing active-tail and continuous-history routes; no new authentication endpoint or history transaction is introduced. Session Worker publication changes remain excluded under the [delivery scope](../overview.md#d-dotnet-delivery-scope).

## Merged original-App qualification

`mainHostRuntimeDelta.e2e.mjs` qualifies the bounded runtime/control/notice/communication producers through a disposable normal host and controlled Responses provider. It checks actual HTTP control admission and revisioned feedback, App Stop and alias-send cards without later prose, history/list/Architecture/reconnect projection agreement, independent foreground/compact retries and cancellation, typed durable and failed-authority temporary notices, successful direct/unified/paused-script sends with current-slice continuation, and opaque fabricated result data that cannot become a delivery card. It also checks generated root/prefix login, invalid-token/network-failure recovery with the real frontend-owned cookie, prepared navigation, and reopening existing metadata. Continue checks correlated admission within its existing bound and the next physical provider request before a second Continue and Stop. The authority-failure check waits for the post-notice busy state emitted after the independent strict-release attempt, then asserts the retained checkpoint. Failed strict busy finalization and startup resume retain their existing contracts; no new notice-recovery mechanism is introduced.

`mainHostWorkbenchParity.e2e.mjs` runs a disposable normal host with real file-token login, actual Agent/Session creation, local scripted provider requests and the built original App. It checks request/tool timing and result-first Conversation rendering, existing task/status/cumulative usage consumers, Debug/Timeline JSON dialogs, stable Chat content across splits, History draft/submission separation with the real `VECTOR_DISABLED` response, docked/restored local PTYs, and the ordinary Code launch preference. Optional official Code-OSS assets additionally exercise persistent embedded workbench, actual filesystem saves, SCM commit/diff webviews and the terminal extension. Prepared asset version evidence is in [Code services](../units/code-services.md#asset-adaptation-and-version-evidence); the fixture does not infer version parity from a pin.

Targeted merged-client fixtures independently cover pane/iframe/terminal identity, pending History submission behavior, inspector immutability/model disposal and Conversation timing disclosure. These controlled browser fixtures complement, rather than replace, real normal-host/provider qualification. Existing Node, OAuth and Anthropic E2Es remain separate consumers.

The built Vite 8/Rolldown client keeps its recovery script/styles inline in `index.html`; external scripts, styles and lazy chunks remain deployment-relative files under `assets/`. The existing host serves that index with no-store and the original administrator login/prefix boundary, without a new route or endpoint. `mainHostLegacyNodeProjection.e2e.mjs` qualifies a real prefix/login, browser-only missing root-chunk fault and explicit reload recovery alongside retained Session projection. `mainHostNodeConsumers.e2e.mjs` uses a normal host, real CLI/Shell peers, the Nodes workbench directory and onboarding dialog, and exact composer Node/cwd consumers. The output must still be supplied as a complete built WebUI directory at the existing host/publish boundary; a C# build alone does not build or deploy client assets.

`mainHostContinuousDownloads.e2e.mjs` seeds original Source-persisted history, compacts it through a real .NET planner and exercises the built original Conversation consumer with bounded earlier/newer pages, fork caps, live append, reconnect and restored reading windows. It also qualifies archived-image display and cookie-less native file/global-blob downloads under a nested prefix, plus successful direct/nested delivery receipts and exact-target filtering. No frontend substitution or Session-scoped identity route is used.

## Windows desktop consumer

The minimal [desktop host](../units/host-runtime.md#desktop-boundary) embeds the same Main composition and built original App in WinForms/WebView2. It owns an authenticated ephemeral loopback endpoint, not a separately launched backend or a connection to an existing test server. Window/tray lifetime, credential initialization, persisted per-user data and Windows prototype limitations are owned by the host unit.

## Canonical units and tests

- [Shared access identities and scoped WebUI](../units/dotnet-access-identities.md)
- [Host runtime](../units/host-runtime.md)
- [WebUI channel registration](../units/dotnet-webui-core.md)
- [WebUI history/list](../units/dotnet-webui-history-list.md)
- [WebUI files/images](../units/dotnet-webui-files-images.md)
- [WebUI tasks/relations](../units/dotnet-webui-tasks-relations.md)
- [WebUI deletion/terminal](../units/dotnet-webui-lifecycle-terminal.md)
- [WebUI realtime](../units/webui-realtime.md)
- [React WebUI module](../modules/webui.md)
- `WebUiStartupTests`, `WebUiUploadedFilesTests`, `WebUiRealtimeRevisionTests`, `CodeRoutesTests`, and Session/catalog/task tests.
