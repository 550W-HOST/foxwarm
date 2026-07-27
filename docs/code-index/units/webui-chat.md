# Unit: WebUI Chat

Files: packages/webui/src/components/Chat.tsx, packages/webui/src/components/ContextScrollbar.tsx, packages/webui/src/components/contextScrollbarModel.ts, packages/webui/src/chatViewportState.ts, packages/webui/src/sessionHeader.ts, packages/webui/src/modelOptionsLoader.ts, packages/webui/test/chatViewportState.test.mjs, packages/webui/test/contextScrollbarModel.test.mjs, packages/webui/test/contextScrollbar.e2e.mjs, packages/webui/test/sessionHeader.test.mjs, packages/webui/test/modelOptionsLoader.test.mjs, packages/webui/test/sessionHeader.e2e.mjs, packages/webui/test/scrollState.e2e.mjs, packages/webui/test/streamFollow.e2e.mjs

## Purpose

Owns one mounted session's committed history, queued preview, runtime/model snapshot, per-session SSE, message upload/send, stop/dequeue/final-failure retry commands, ASR, debug view, scroll/viewport state, and the desktop context overview scrollbar.

## Export

- default memoized `Chat` component.
- `chatViewportState.ts` and `sessionHeader.ts` export pure tested state/format helpers.
- `contextScrollbarModel.ts` exports pure committed-segment, estimate, context-usage, and row-boundary interpolation helpers used by the desktop overview and focused tests.

## Current handlers

- `handleSend({ text, attachments })`:
  1. rejects missing/empty/loading submissions;
  2. uploads each attachment to `POST /api/upload`;
  3. builds `{ parts, uploadedFiles }`;
  4. appends an optimistic committed-looking user row only when the session is not busy and has no queued work;
  5. starts `POST /api/sessions/:id/message`; busy/queued sends instead schedule targeted history refresh for queue preview.
- `sendSessionCommand(command)` posts `{ text: command }` to the same message route without optimistic user history.
- `handleStop`, `handleRunQueued`, and `handleRetryFinalFailure` send `/stop`, `/dequeue`, and `/retry` respectively.
- There are no current message-index edit/delete/retry handlers in this component.
- ASR appends `/asr/transcribe` or `/asr/stream` to the deployment-relative `API_BASE_PATH`. `getAsrStreamUrl()` builds `${window.location.origin}${API_BASE_PATH}/asr/stream` and switches the HTTP(S) prefix to WS(S); it does not call `makeWebSocketUrl`.

## Per-session state and streaming

- Initial `GET /sessions/:id/history` returns `{ session, messages, queuedMessages, queueLength }`.
- Chat opens one EventSource at `/sessions/:id/stream` and handles model/tool streaming, persisted message updates, canonical `session-state`, queue/history refresh, deletion, and reconnect.
- Reconnect rehydrates only this session before resubscribing; confirmed 404 stops retries.
- Streaming assistant deltas form a temporary synthetic message.
- Persisted update events replace an existing row by stable metadata before timestamp dedupe.
- Canonical `runtimeState` drives active display with legacy busy fallback only when runtime state is absent.
- Queue previews remain a separate render-only timeline and never enter committed messages.

## Viewport behavior

- Streaming follow is an explicit latch. Upward wheel/keyboard/touch/scrollbar intent detaches before a token/layout update can undo it.
- Only actual-bottom tolerance or the bottom action re-enables follow.
- Remount state is in-memory by canonical session ID: either `bottom` or a stable committed-message anchor plus pixel offset.
- Restoration can expand the full timeline, uses idempotent row-offset correction, retains native browser scroll anchoring, and is cancelled by new user scroll input.
- A ResizeObserver reapplies active bottom/anchor state for late layout changes.
- Desktop reserves a 48px context-overview gutter beside, not instead of, the native message scroller. The overview represents full committed history even while Chat initially mounts only the newest timeline rows. Its custom pointer interaction requests a native-container scroll and uses the existing explicit-user-intent latch; it never creates a second scroll owner or writes during passive geometry updates.
- `contextScrollbarModel.ts` owns browser-safe message estimate text, stable logical segments, tool-response-to-preceding-call row association, and real-usage-plus-tail context accounting. It uses the shared lightweight estimator and the latest persisted model-message input/cache/output usage as its real anchor; later committed content is estimated. `ContextScrollbar` uses rendered committed-row anchors and interpolation only for the viewport marker.

## Other behavior

- Header state and cwd come from the per-session history/stream snapshot, including in Code leaf Chat.
- Debug view fetches the session debug file payload and builds/copies current internal JSON.
- Timeline defaults to a recent subset with explicit full expansion.
- Horizontal containment remains on the chat/timeline boundaries while tables/output own intentional inner scrolling.
- Chat fetches model options on mount and again whenever the composer popup opens. A latest-request gate owns options, errors, and loading state, so stale successes/failures/finalizers cannot overwrite a newer refresh. The popup's settings action is passed upward; normal Chat delegates to App and embedded Chat emits the fixed Code-host message.

## Dependencies

ChatComposer, ChatTimeline, ProcessingStatus, chat shared types/renderers, ToolScript progress context, and `API_BASE_PATH`. Model-settings navigation is canonical in [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation).

## Design decisions

### D-chat-queued-preview

Busy-time sends avoid a duplicate optimistic committed row; queue preview is reloaded separately from committed history.

### D-chat-user-follow-intent

Token/layout growth cannot override explicit upward user intent. Rejoin occurs only at the actual bottom or by explicit action.

### D-chat-ephemeral-viewport

Viewport state is ephemeral browser memory keyed by canonical session ID, not workbench/local-storage state.

### D-chat-desktop-context-overview

[2026-07-27] Desktop Chat hides only the native message scrollbar chrome and reserves a real 48px right-side context-overview gutter; the existing message element remains the sole browser scroll container and mobile remains unchanged. The overview stack immediately covers all committed non-temporary history, while its viewport marker progressively uses mounted stable rows. The occupied height is the latest provider input/cache/output measurement plus estimated later committed tail, divided among messages by shared-estimator weights; unused capacity is the remaining real-context fraction. Pointer clicks jump and viewport drags scroll the native container to the corresponding logical message/token location, detaching streaming follow through the same user-intent path as native interaction. Tool responses paired into a preceding model row share that row's geometry. Do not couple the overview to queued, nested, synthetic streaming, or collapse-state timelines.

## Canonical ownership

Per-session versus global stream ownership is canonical in [D-webui-session-stream-ownership](../modules/webui.md#d-webui-session-stream-ownership).
