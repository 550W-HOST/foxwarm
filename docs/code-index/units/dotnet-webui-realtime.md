# Unit: WebUI realtime event publisher

Files: `dotnet/Foxwarm/Channels/WebUi/WebUiRealtime.cs`
Secondary files: `dotnet/Foxwarm/Channels/WebUi/WebUiContract.cs`

## Purpose

Publishes authenticated Session/message/tool/task/list/presentation/terminal events with revision/ack and bounded subscriber lifecycle to React WebUI clients.

## Stable methods and callers

`WebUiRealtime` registers/removes WebSocket subscribers, emits typed event envelopes, tracks per-subscriber revision/ack/backpressure, and closes stale/broken clients. `HttpServer`/`WebUIChannel` supply auth and route/session dependencies; SessionManager, SessionRuntime, TaskService, TerminalRegistry, and Code services invoke event hooks after their own state transitions.

## Contract and side effects

Realtime is a notification/projection boundary, not Session authority. Committed-message and queue-batch envelopes use [WebUI message transport](./webui-message-transport.md); transient argument cadence and flush ordering remain [exact-owner responsibilities](./session-turns.md#transient-presentation-and-failure-feedback). A stream delta or task event may arrive before a later durable JSON/catalog publication; revision barriers and bounded initialization buffering let the browser reconcile rather than treating every event as committed history. Subscriber failure is isolated from the owner/save lane.

Scoped clients retain role-safe state/message projections and current exact/Agent bindings across initial snapshots and queued sends. Catalog/log subscriptions are rejected; affected credential/scope changes and stale canonical moves close only those connections. The [shared access unit](./dotnet-access-identities.md) owns the authority and revocation contract.

A superseding subscription initialization retains already-buffered live events only for subscriptions still present in the new union. The final flush rechecks both that union and the exact Session owner. A captured admitted owner must still match; an event produced before cold admission instead matches the exact owner admitted by that initialization, so registered channel sends are not lost merely because their target was cold. Only a still-current admitted owner can receive either form. The publisher sends retained events after state/draft snapshots and before `subscriptions-applied`. Removed subscriptions, replaced owners, stale initialization tasks and stale queued revisions do not revive old replies. The initialization buffer has the same 1,000-event bound as the TypeScript hub; it is not durable replay or command history. Scoped authorization remains enforced at the actual send boundary.

The administrator-only file-backed Logs topic shares the same physical socket and sender, with an independent logical lifetime, reconnect cursor and bounded outbound backlog. It never enters the Session initialization pending list or restarts for an unrelated revision. The [managed Main Logs unit](./dotnet-webui-logs.md) owns reader/tail/producer behavior and queue accounting. Existing Session/list revision and queue policies remain unchanged.

## Tests

`WebUiRealtimeRevisionTests.cs` (registered cold-target channel delivery over HTTP/WebSocket, retained/removed/deleted command replies, replaced-owner admission and snapshot ordering); `WebUiQueuePreviewTests.cs` (bounded system parts and unchanged queue); `WebUiAccessTests.cs`; stream/list/task/terminal event tests.
