# Unit: WebUI realtime event publisher

Files: `dotnet/Foxwarm/Channels/WebUi/WebUiRealtime.cs`

## Purpose

Publishes authenticated Session/message/tool/task/list/presentation/terminal events with revision/ack and bounded subscriber lifecycle to React WebUI clients.

## Stable methods and callers

`WebUiRealtime` registers/removes WebSocket subscribers, emits typed event envelopes, tracks per-subscriber revision/ack/backpressure, and closes stale/broken clients. `HttpServer`/`WebUIChannel` supply auth and route/session dependencies; SessionManager, SessionRuntime, TaskService, TerminalRegistry, and Code services invoke event hooks after their own state transitions.

## Contract and side effects

Realtime is a notification/projection boundary, not Session authority. A stream delta or task event may arrive before a later durable JSON/catalog publication; event revision/ack and bounded replay let the browser reconcile rather than treating every event as committed history. Subscriber failure is isolated from the owner/save lane.

## Tests

`WebUiRealtimeRevisionTests.cs`; `WebUiRealtimeRevisionTests.cs`; stream/list/task/terminal event tests.
