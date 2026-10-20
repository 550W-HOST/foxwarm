# Unit: WebUI realtime event publisher

Files: `dotnet/Foxwarm/Channels/WebUi/WebUiRealtime.cs`

## Purpose

Publishes authenticated Session/message/tool/task/list/presentation/terminal events with revision/ack and bounded subscriber lifecycle to React WebUI clients.

## Stable methods and callers

`WebUiRealtime` registers/removes WebSocket subscribers, emits typed event envelopes, tracks per-subscriber revision/ack/backpressure, and closes stale/broken clients. `HttpServer`/`WebUIChannel` supply auth and route/session dependencies; SessionManager, SessionRuntime, TaskService, TerminalRegistry, and Code services invoke event hooks after their own state transitions.

## Contract and side effects

Realtime is a notification/projection boundary, not Session authority. A stream delta or task event may arrive before a later durable JSON/catalog publication; event revision/ack and bounded replay let the browser reconcile rather than treating every event as committed history. Subscriber failure is isolated from the owner/save lane.

Scoped clients retain role-safe state/message projections and current exact/Agent bindings across initial snapshots and queued sends. Catalog/log subscriptions are rejected; affected credential/scope changes and stale canonical moves close only those connections. The [shared access unit](./dotnet-access-identities.md) owns the authority and revocation contract.

The administrator-only file-backed Logs topic shares the same physical socket and sender, with an independent logical lifetime, reconnect cursor and bounded outbound backlog. It never enters the Session initialization pending list or restarts for an unrelated revision. The [managed Main Logs unit](./dotnet-webui-logs.md) owns reader/tail/producer behavior and queue accounting. Existing Session/list revision and queue policies remain unchanged.

## Tests

`WebUiRealtimeRevisionTests.cs`; `WebUiAccessTests.cs`; stream/list/task/terminal event tests.
