# Unit: WebUI Chat

Files: packages/webui/src/components/Chat.tsx, packages/webui/src/chatViewportState.ts, packages/webui/src/sessionHeader.ts, packages/webui/test/chatViewportState.test.mjs, packages/webui/test/sessionHeader.test.mjs, packages/webui/test/sessionHeader.e2e.mjs, packages/webui/test/scrollState.e2e.mjs, packages/webui/test/streamFollow.e2e.mjs

## Purpose

Owns one mounted session's committed history, queued preview, runtime/model snapshot, per-session SSE, message upload/send, stop/dequeue/final-failure retry commands, ASR, debug view, and scroll/viewport state.

## Export

- default memoized `Chat` component.
- `chatViewportState.ts` and `sessionHeader.ts` export pure tested state/format helpers.

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

## Other behavior

- Header state and cwd come from the per-session history/stream snapshot, including in Code leaf Chat.
- Debug view fetches the session debug file payload and builds/copies current internal JSON.
- Timeline defaults to a recent subset with explicit full expansion.
- Horizontal containment remains on the chat/timeline boundaries while tables/output own intentional inner scrolling.

## Dependencies

ChatComposer, ChatTimeline, ProcessingStatus, chat shared types/renderers, ToolScript progress context, and `API_BASE_PATH`.

## Design decisions

### D-chat-queued-preview

Busy-time sends avoid a duplicate optimistic committed row; queue preview is reloaded separately from committed history.

### D-chat-user-follow-intent

Token/layout growth cannot override explicit upward user intent. Rejoin occurs only at the actual bottom or by explicit action.

### D-chat-ephemeral-viewport

Viewport state is ephemeral browser memory keyed by canonical session ID, not workbench/local-storage state.

## Canonical ownership

Per-session versus global stream ownership is canonical in [D-webui-session-stream-ownership](../modules/webui.md#d-webui-session-stream-ownership).
