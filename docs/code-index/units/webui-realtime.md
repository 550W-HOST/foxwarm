# Unit: WebUI realtime transport

Files: `packages/webui/src/realtime.ts`, `packages/webui/src/sessionContinuation.ts`, `packages/webui/test/realtimeTransport.test.mjs`

## Purpose

Maintains page-scoped WebSocket transport and logical Session subscriptions for Chat and list updates.

## Behavior

One physical connection multiplexes logical subscriptions. Revision and sequence checks reject stale events, while reconnect and refresh paths recover browser presentation from host snapshots. The transport does not replace Session owner serialization or durable persistence.

## Tests

Realtime transport, continuation, reconnect, and bounded list fixtures cover event ordering and recovery.
