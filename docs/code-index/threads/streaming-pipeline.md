# Thread: streaming-pipeline

## Overview

The real-time streaming flow from LLM token generation through server-side event emission to browser-based rendering in the Web UI, enabling users to see responses as they are generated.

## Steps

1. The LLM adapter initiates a streaming request to the provider (OpenAI SSE stream or Anthropic equivalent).
2. `collectOpenAIResponsesStream` or `collectOpenAIChatCompletionsStream` reassembles the SSE chunks, invoking a progress callback on each delta and optional raw-capture callbacks for decoded chunks / complete SSE blocks.
3. `createModelStreamEventEmitter` throttles these deltas and emits `model-stream-update` `SessionStreamEvent` objects into the session's event bus.
4. The WebUI channel's Express server maintains canonical-id per-session SSE connections at `/api/sessions/:sessionId/stream`, plus a separate global list stream.
5. Each per-session connection starts with a canonical `session-state` snapshot. Model/tool deltas continue as `session-event`; committed history updates use `message`; runtime/queue transitions use further `session-state` events.
6. The React `webui-chat` component receives all of these through its one session-scoped `EventSource`, updating partial response content and ProcessingStatus without polling the global session list.
   Separately, normal App and Code's embedded Sidebar consume global `sessions-updated`; their list fetches use a latest-request-wins gate so clustered events cannot apply responses out of order and hide a newly created child.
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

- [2026-07-22] WebUI streaming bottom-follow is intent-latched. Explicit upward user interaction exits follow immediately, subsequent token growth must preserve the detached viewport, and only reaching the actual bottom or using the bottom action reenables follow; do not approximate this solely by enlarging the near-bottom threshold.
- [2026-06-25] Streaming diagnostics should capture provider raw SSE without changing parsing semantics: collectors expose raw chunk/block callbacks, while the request/logging layer decides how much to retain and where to serialize it.
- [2026-06-04] WebUI `model-stream-update` remains WebUI/SSE-oriented and should not be reused directly for WeWork stream-card updates. WeWork uses lower-frequency turn-level `channelTurnProgress` broadcasts bound to the channel stream id, so card updates can show `🤔 thinking` and batch tool status without token-level churn or history pollution.
- [2026-06-05] For WeWork stream cards, an LLM response that has both model text and tool calls should be emitted as one turn-level progress/card update carrying both text and `⌛️` running tools. This avoids a separate text update being delayed ahead of the tool-status update, especially in WebSocket mode where stream pushes are ack-serialized.
- [2026-07-15] WebUI's per-session stream carries both transient model/tool events and canonical session-state snapshots. Initial history plus the subscription-time snapshot closes the fetch/subscribe race; reconnect re-fetches only that session, while global session-list SSE remains independent.
