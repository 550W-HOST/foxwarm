# Thread: streaming-pipeline

## Overview

The real-time streaming flow from LLM token generation through server-side event emission to browser-based rendering in the Web UI, enabling users to see responses as they are generated.

## Steps

1. The LLM adapter initiates a request to the provider (OpenAI or Gemini SSE stream, or the Anthropic response path).
2. The selected OpenAI or Gemini stream collector reassembles SSE chunks into semantic response parts, invoking a progress callback on each delta and optional raw-capture callbacks for decoded chunks / complete SSE blocks. Transport-level text fragments are coalesced before the committed response is normalized.
3. `createModelStreamEventEmitter` throttles these deltas and emits `model-stream-update` `SessionStreamEvent` objects into the session's event bus.
4. The WebUI channel multiplexes current-browser list and canonical per-session subscriptions over one authenticated `/api/webui/stream` WebSocket per browsing context. Legacy per-session and global SSE routes remain compatibility surfaces.
5. A revisioned subscription acknowledgement installs requested/canonical mappings before initial snapshots. Each subscribed session then receives a canonical `session-state`; model/tool deltas continue as `session-event`, committed history updates use `message`, and runtime/queue transitions plus bounded `historyVersion` mutation signals use further `session-state` events.
   Under Session-worker placement, cumulative model updates may be coalesced in the Worker, but the final pending update is flushed onto the single presentation tail before the corresponding committed model message. Structural stream resets also flush older pending updates first and cancel their timer. Therefore a stale cumulative frame can never recreate a synthetic WebUI draft after its canonical model row.
6. The page-scoped browser transport fans session envelopes to `webui-chat` logical subscribers, updating partial response content and ProcessingStatus without polling the global session list. Normal App and Code's embedded list-data roots consume filtered logical list subscriptions on that same socket; clustered refresh intents are fixed-delay coalesced without overlapping scheduled refreshes, and session-list fetches retain a latest-request-wins application gate. The canonical scheduling contract is [D-webui-app-global-list-gate](../units/webui-app.md#d-webui-app-global-list-gate).
7. `webui-chat-timeline` renders the accumulating tokens in real-time within the model's message bubble, including reasoning cards and tool call progress indicators.
   `webui-chat` follows the bottom only while its explicit follow latch is enabled. User wheel/scrollbar/touch/keyboard intent disables the latch before a token-driven resize can run; the growing stream then preserves the committed-message anchor until the user returns to the actual bottom.
8. The LLM response logger writes the parsed aggregate response plus bounded `rawStream.body` and `rawStream.sseBlocks` to `state/logs/recent`; if the turn ultimately fails and logs are moved to `${date}-error`, the raw stream capture moves with the response/attempt log.
9. When the stream completes, a final event signals the end of the turn; the UI transitions from streaming state to the complete message view.
10. If the response includes tool calls, `webui-tool-timeline` renders progress indicators during execution, updating as tool results arrive via subsequent stream events.

## Modules Involved

- llm (stream collection, event emission)
- infrastructure (SessionStreamEvent types, HTTP server)
- channels (WebUI channel SSE endpoint)
- webui (React components consuming the stream)
- session-core (event bus routing)

## Key Files

- `src-llm-openai` (SSE stream collectors, progress callbacks)
- `src-llm` (createModelStreamEventEmitter, throttled emission)
- `src-channels-webui` (Express SSE endpoint)
- `src-types` (SessionStreamEvent definition)
- `webui-chat` (SSE consumption, state management)
- `webui-chat-timeline` (real-time message rendering)
- `webui-tool-timeline` (tool progress rendering)

## Design Decisions

### D-webui-multiplexed-realtime

[2026-08-22] Current WebUI code owns exactly one authenticated, deployment-relative realtime WebSocket per browsing context. Sidebar variants, Architecture, and every mounted split-pane Chat register logical list/session subscriptions with the page transport; components must not create their own EventSource or WebSocket. The client sends the complete subscription union with a monotonic revision, and the server installs that revision before acknowledging it, then emits initial snapshots followed by live events buffered during initialization. `subscriptions-accepted` is the register-before-history boundary: a newly registered Chat starts its history request before snapshot/live delivery can race that request, while existing subscribers do not re-bootstrap for unrelated subscription changes. Reconnect resends the complete union and uses existing bounded-list/history reconciliation instead of durable event replay.

This physical-connection boundary is required for correctness, not only efficiency. Independent SSE ownership can consume all six HTTP/1.1 per-origin request slots; a refresh then cannot obtain a document connection, and the old page cannot unmount to close its SSE streams, creating a navigation deadlock. A WebSocket leaves the ordinary HTTP request pool after upgrade and supports dynamic subscription changes without reopening physical connections. SharedWorker cross-tab ownership and HTTP/2 are not required for this invariant. Legacy SSE routes remain temporary compatibility surfaces but are not used by current WebUI components.

### D-streaming-optimistic-message-identity

[2026-07-28] Every direct non-command WebUI send carries a bounded browser-generated `clientMessageId` through the channel message and queue item into the persisted user message metadata. Chat may render that send optimistically only on the idle/no-queue path, then reconciles the canonical SSE/history row into the same slot by client identity; text equality must never delete or identify another user row. Manually composed slash commands remain non-optimistic because command dispatch does not persist a user row. Their temporary command-response rows stay browser-local and retain their mounted-timeline slot across bootstrap, reconnect, and internal/trailing history refreshes; a page refresh or Chat remount clears them. They never enter persistence, archive/search, model context, queue preview, or the committed ContextScrollbar model. Persisted message `seq`/`id` remain canonical for general reconciliation, with timestamps only as a legacy fallback. A failed POST removes only a still-pending optimistic row; once SSE/history has reconciled the ID, later transport failure cannot remove the canonical row or create a false failure notice. Initial mount and reconnect register/open the per-session stream before requesting history. Messages committed before the snapshot starts are therefore in server history, while later messages arrive on the registered stream and are journaled/replayed before the snapshot is accepted. A stream failure before `onopen` uses only the lightweight authenticated per-session state probe to decide missing versus reconnect; it never downloads full history. The sole full snapshot begins after a stream opens. A post-request `session-state` event owns runtime/model/cwd/queue state over older history fields, and a post-request model-stream event prevents history from clearing the newer live draft. A queue-length mismatch defers the ambiguous preview and requests one coalesced trailing refresh. `session-deleted` invalidates and aborts history ownership, clears pending refresh work, and cannot be undone by a delayed response. Same-session refresh triggers share the active download and set at most one trailing refresh; only deletion, session replacement, or unmount aborts the active request.

### D-streaming-worker-commit-order

[2026-08-12] Session-worker presentation keeps one ordered tail across cumulative model-stream frames and appended-message copies. Before forwarding a committed model message, the Worker flushes and cancels every pending coalesced cumulative frame; before forwarding a structural reset, it likewise flushes older frames and cancels the timer. The committed message may clear WebUI's synthetic draft only after its final cumulative frame, and no frame from that stream generation may arrive afterward. Preserve this transport-order barrier rather than adding persisted stream state, message-body projections, generic acknowledgements, or UI content-based deduplication. Transient presentation remains droppable and correction still comes from committed history/projection.

- [2026-07-22] WebUI streaming bottom-follow is intent-latched. Explicit upward user interaction exits follow immediately, subsequent token growth must preserve the detached viewport, and only reaching the actual bottom or using the bottom action reenables follow; do not approximate this solely by enlarging the near-bottom threshold.
- [2026-06-25] Streaming diagnostics should capture provider raw SSE without changing parsing semantics: collectors expose raw chunk/block callbacks, while the request/logging layer decides how much to retain and where to serialize it.
- [2026-06-04] WebUI `model-stream-update` remains WebUI/SSE-oriented and should not be reused directly for WeWork stream-card updates. WeWork uses lower-frequency turn-level `channelTurnProgress` broadcasts bound to the channel stream id, so card updates can show `🤔 thinking` and batch tool status without token-level churn or history pollution.
- [2026-06-05] For WeWork stream cards, an LLM response that has both model text and tool calls should be emitted as one turn-level progress/card update carrying both text and `⌛️` running tools. This avoids a separate text update being delayed ahead of the tool-status update, especially in WebSocket mode where stream pushes are ack-serialized.
- [2026-07-15] WebUI's per-session stream carries both transient model/tool events and canonical session-state snapshots. Initial history plus the subscription-time snapshot closes the fetch/subscribe race; reconnect re-fetches only that session, while global session-list SSE remains independent.
