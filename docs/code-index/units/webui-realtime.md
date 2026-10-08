# Unit: WebUI realtime transport

Files: packages/webui/src/realtime.ts, packages/webui/test/realtimeTransport.test.mjs, src/channels/webuiRealtime.ts, src/channels/webuiRealtime.test.ts
Secondary files: packages/webui/src/boundedSessionList.ts, packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/components/Chat.tsx, src/channels/webuiChannel.ts

## Purpose

Owns the authenticated page-scoped WebUI WebSocket and the server-side multiplexing hub. Sidebar/list, Architecture, and every mounted Chat own logical subscriptions only; their count never creates additional physical WebUI realtime connections inside one browsing context.

## Browser transport

`WebUiRealtimeTransport` is a page singleton with injectable socket/timer dependencies for deterministic tests. It:

- maintains reference-counted list, per-session and optional Logs logical subscriptions;
- sends one complete, revisioned `set-subscriptions` snapshot containing the union of desired IDs;
- preserves requested-to-canonical mappings from `subscriptions-accepted` and filters bounded list deltas back to each logical consumer;
- reports registration to a new subscriber exactly once per physical socket generation, while reconnect registration reaches every retained subscriber;
- fences stale socket generations and reconnect timers, uses bounded exponential backoff with jitter, and suspends cleanly across `pagehide`/`pageshow`;
- derives `/api/webui/stream` through `makeWebSocketUrl`, preserving deployment prefixes and WS/WSS selection.

`subscriptions-accepted` is the registration boundary: the server has installed subscriptions but has not yet emitted the asynchronous initial snapshots. Chat begins history at this point, preserving the register-before-history/live-event ordering contract. `subscriptions-applied` marks completion of initial snapshots and buffered events but does not re-bootstrap existing logical subscribers.

The browser sends its first subscription snapshot after receiving the server's `connected` frame, not merely on WebSocket open: WebUI identity authentication can still be asynchronous after the HTTP upgrade, so sending on open could arrive before the server installs its message handler.

## Server hub

`WebUiRealtimeHub` authenticates the HTTP upgrade, validates bounded subscription snapshots, canonicalizes aliases, and multiplexes existing WebUI payloads over one socket. A client update installs its session/list sets before loading snapshots; live events that arrive during initialization are buffered and emitted after the snapshot. A newer requested revision supersedes an in-flight older snapshot, preventing stale untagged payloads from reaching the browser.

The WebUI identity connection authenticates through the WebUI identity verifier and accepts subscriptions to the current canonical Session through either its current ID or a committed alias matching a stored WebUI identity binding. WebUI identity list subscriptions, missing or ambiguous IDs, and subscriptions resolving outside the bound Session fail before installing ownership or sending snapshots. If the Session moves during snapshot loading, that stale snapshot is discarded; when an active canonical subscription moves, the WebUI identity socket reconnects so the requested alias can resolve to the new current ID. WebUI identity credentials are rechecked on each subscription change and each keepalive; revoked/expired connections close and release ownership at the next check. Default authenticated WebSocket consumers retain their existing administrator behavior. The hub exposes focused broadcast methods for session payloads, bounded list deltas, and catalog invalidation. On a first Worker presentation subscription it awaits activation before loading the exact-owner model draft, closing the no-subscriber-to-snapshot gap. The full draft snapshot is sent before initialization-buffered deltas. It preserves first/last presentation-subscriber semantics when combined with legacy SSE clients in `WebUIChannel`. Close, error, send failure, initialization failure, and session deletion all release subscription ownership; a bounded pending-event queue prevents unbounded initialization growth.

## Wire protocol

Client message:

- `set-subscriptions` — positive `revision`, `sessionListActive`, `sessionListIds`, `sessionIds`, and optional `logs: { id, cursor?: { fileId, offset } }`.

Server messages:

- `connected` — authenticated physical socket exists;
- `subscriptions-accepted` — requested/canonical maps are installed for this revision;
- existing `session-list-delta`, `sessions-updated`, `session-state`, `session-event`, `message`, `typing`, and `session-deleted` payloads, with `sessionId` on session-scoped envelopes;
- `model-stream-snapshot` — exact-owner cumulative transient draft with stream/iteration/sequence watermark, server `startedAt`, existing outer `llmRequestId`, and optional indexed Responses `parts`, or `draft:null`; following live events carry the same request identity and inclusive sequence coverage ranges so the browser can distinguish Worker coalescing from presentation loss and reconcile exact canonical history rows;
- `subscriptions-applied` — snapshot plus buffered-live initialization completed;
- `logs-snapshot`, `logs-delta`, `logs-gap`, `logs-reset`, and `logs-error` — independently cursor-addressed optional logger-file frames with a logical `logsId`;
- `protocol-error` — invalid subscription or initialization failure; the connection is then failed rather than left partially initialized.

Reconnect does not require durable event replay. The client resends its complete subscription set, list consumers run their bounded refresh scheduler, and Chat runs its existing history reconciliation.

Logs starts after ordinary subscription initialization and does not enter the Session pending-event queue. An unchanged Logs lifetime survives unrelated subscription revisions; reconnect sends its last file/byte frontier. Full fixed-file, bounded catch-up and topic-only gap semantics are canonical in [WebUI Logs](./webui-logs.md#live-contract). Channel stop disposes hub clients and their log subscriptions.

## Compatibility

Legacy `/api/sessions/stream` and `/api/sessions/:sessionId/stream` SSE routes remain available for older clients. Current WebUI components do not construct `EventSource`; compatibility SSE does not participate in the page connection-budget guarantee.

## Tests

- Browser transport tests prove N logical consumers use one socket, disjoint list deltas remain isolated, later subscribers bootstrap on an already-open socket, reconnect resubscribes the union, and dispose fences stale callbacks.
- Hub tests cover authentication, alias resolution, snapshot-before-buffered-live ordering, superseded revisions, cleanup, and the real HTTP WebSocket upgrade path.
- Chat browser fixtures use the revisioned WebSocket handshake and preserve register-before-history behavior across reconnect.

## Canonical ownership

The cross-module rationale and ordering contract are canonical in [D-webui-multiplexed-realtime](../threads/streaming-pipeline.md#d-webui-multiplexed-realtime).
