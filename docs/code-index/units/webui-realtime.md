# Unit: WebUI realtime transport

Files: packages/webui/src/realtime.ts, packages/webui/test/realtimeTransport.test.mjs, src/channels/webuiRealtime.ts, src/channels/webuiRealtime.test.ts
Secondary files: packages/webui/src/boundedSessionList.ts, packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/components/Chat.tsx, src/channels/webuiChannel.ts

## Purpose

Owns the authenticated page-scoped WebUI WebSocket and the server-side multiplexing hub. Sidebar/list, Architecture, and every mounted Chat own logical subscriptions only; their count never creates additional physical WebUI realtime connections inside one browsing context.

## Browser transport

`WebUiRealtimeTransport` is a page singleton with injectable socket/timer dependencies for deterministic tests. It:

- maintains reference-counted list and per-session logical subscriptions;
- sends one complete, revisioned `set-subscriptions` snapshot containing the union of desired IDs;
- preserves requested-to-canonical mappings from `subscriptions-accepted` and filters bounded list deltas back to each logical consumer;
- reports registration to a new subscriber exactly once per physical socket generation, while reconnect registration reaches every retained subscriber;
- fences stale socket generations and reconnect timers, uses bounded exponential backoff with jitter, and suspends cleanly across `pagehide`/`pageshow`;
- derives `/api/webui/stream` through `makeWebSocketUrl`, preserving deployment prefixes and WS/WSS selection.

`subscriptions-accepted` is the registration boundary: the server has installed subscriptions but has not yet emitted the asynchronous initial snapshots. Chat begins history at this point, preserving the register-before-history/live-event ordering contract. `subscriptions-applied` marks completion of initial snapshots and buffered events but does not re-bootstrap existing logical subscribers.

## Server hub

`WebUiRealtimeHub` authenticates the HTTP upgrade, validates bounded subscription snapshots, canonicalizes aliases, and multiplexes existing WebUI payloads over one socket. A client update installs its session/list sets before loading snapshots; live events that arrive during initialization are buffered and emitted after the snapshot. A newer requested revision supersedes an in-flight older snapshot, preventing stale untagged payloads from reaching the browser.

The hub exposes focused broadcast methods for session payloads, bounded list deltas, and catalog invalidation. It preserves first/last presentation-subscriber semantics when combined with legacy SSE clients in `WebUIChannel`. Close, error, send failure, initialization failure, and session deletion all release subscription ownership; a bounded pending-event queue prevents unbounded initialization growth.

## Wire protocol

Client message:

- `set-subscriptions` — positive `revision`, `sessionListActive`, `sessionListIds`, and `sessionIds`.

Server messages:

- `connected` — authenticated physical socket exists;
- `subscriptions-accepted` — requested/canonical maps are installed for this revision;
- existing `session-list-delta`, `sessions-updated`, `session-state`, `session-event`, `message`, `typing`, and `session-deleted` payloads, with `sessionId` on session-scoped envelopes;
- `subscriptions-applied` — snapshot plus buffered-live initialization completed;
- `protocol-error` — invalid subscription or initialization failure; the connection is then failed rather than left partially initialized.

Reconnect does not require durable event replay. The client resends its complete subscription set, list consumers run their bounded refresh scheduler, and Chat runs its existing history reconciliation.

## Compatibility

Legacy `/api/sessions/stream` and `/api/sessions/:sessionId/stream` SSE routes remain available for older clients. Current WebUI components do not construct `EventSource`; compatibility SSE does not participate in the page connection-budget guarantee.

## Tests

- Browser transport tests prove N logical consumers use one socket, disjoint list deltas remain isolated, later subscribers bootstrap on an already-open socket, reconnect resubscribes the union, and dispose fences stale callbacks.
- Hub tests cover authentication, alias resolution, snapshot-before-buffered-live ordering, superseded revisions, cleanup, and the real HTTP WebSocket upgrade path.
- Chat browser fixtures use the revisioned WebSocket handshake and preserve register-before-history behavior across reconnect.

## Canonical ownership

The cross-module rationale and ordering contract are canonical in [D-webui-multiplexed-realtime](../threads/streaming-pipeline.md#d-webui-multiplexed-realtime).
