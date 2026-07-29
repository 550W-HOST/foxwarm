# Unit: WebUI Chat

Files: packages/webui/src/components/Chat.tsx, packages/webui/src/components/ContextScrollbar.tsx, packages/webui/src/components/contextScrollbarModel.ts, packages/webui/src/chatHistoryState.ts, packages/webui/src/chatViewportState.ts, packages/webui/src/sessionHeader.ts, packages/webui/src/modelOptionsLoader.ts, packages/webui/test/chatHistoryState.test.mjs, packages/webui/test/chatHistoryLoading.e2e.mjs, packages/webui/test/chatViewportState.test.mjs, packages/webui/test/contextScrollbarModel.test.mjs, packages/webui/test/contextScrollbar.e2e.mjs, packages/webui/test/sessionHeader.test.mjs, packages/webui/test/modelOptionsLoader.test.mjs, packages/webui/test/sessionHeader.e2e.mjs, packages/webui/test/scrollState.e2e.mjs, packages/webui/test/streamFollow.e2e.mjs
Secondary files: packages/webui/src/contextScrollbarSettings.ts

## Purpose

Owns one mounted session's committed history, queued preview, runtime/model snapshot, per-session SSE, message upload/send, stop/dequeue/retry commands, ASR, debug view, scroll/viewport state, and the desktop context overview scrollbar.

## Export

- default memoized `Chat` component.
- `chatHistoryState.ts`, `chatViewportState.ts`, and `sessionHeader.ts` export pure tested reconciliation, viewport, and state/format helpers.
- `contextScrollbarModel.ts` exports pure committed-segment, estimate, context-usage, and row-boundary interpolation helpers used by the desktop overview and focused tests.

## Current handlers

- `handleSend({ text, attachments })`:
  1. rejects missing/empty/loading submissions;
  2. uploads each attachment to `POST /api/upload`;
  3. builds `{ parts, uploadedFiles }`;
  4. creates one browser `clientMessageId` and appends an optimistic committed-looking user row only when the session is not busy and has no queued work;
  5. starts `POST /api/sessions/:id/message`; busy/queued sends instead schedule targeted history refresh for queue preview.
- Manually typed slash commands use the same POST route but omit optimistic history and `clientMessageId`, matching command dispatch's non-persisted user-input boundary.
- `sendSessionCommand(command)` posts `{ text: command }` to the same message route without optimistic user history.
- `handleStop`, `handleRunQueued`, and `handleRetryLlmNotice` send `/stop`, `/dequeue`, and `/retry` respectively.
- There are no current message-index edit/delete/retry handlers in this component.
- ASR appends `/asr/transcribe` or `/asr/stream` to the deployment-relative `API_BASE_PATH`. `getAsrStreamUrl()` builds `${window.location.origin}${API_BASE_PATH}/asr/stream` and switches the HTTP(S) prefix to WS(S); it does not call `makeWebSocketUrl`.

## Per-session state and streaming

- Initial `GET /sessions/:id/history` returns `{ session, messages, persistentMemorySnapshot, queuedMessages, queueLength }`; it is the sole normal bootstrap request for committed history and snapshot data.
- Chat opens one EventSource at `/sessions/:id/stream` before requesting history and handles model/tool streaming, persisted message updates, canonical `session-state`, queue/history refresh, deletion, and reconnect. Each successful initial/reconnect open starts that session's coalesced history snapshot. A failure before `onopen` calls only `/sessions/:id/state`: 404 marks missing and stops retries, while an existing state schedules another stream-first attempt without downloading history.
- Streaming assistant deltas form a temporary synthetic message.
- Persisted user events replace their matching optimistic row in place by `clientMessageId`; all persisted updates prefer stable client/seq/id metadata before legacy timestamp dedupe. A later failed POST removes only an unreconciled optimistic row. An in-flight history request replays newer SSE rows and preserves unmatched pending sends before it can commit. Post-request `session-state` fields and model-stream drafts stay stream-owned; a mismatched queue preview waits for one coalesced trailing refresh. Deletion invalidates/aborts history and clears pending refresh work. Same-session refresh triggers reuse that request and request at most one trailing refresh; deletion, session replacement, and unmount abort it.
- Temporary command-response rows remain browser-local but are reinserted at their existing mounted-timeline anchors after internal history snapshots. They clear on page refresh/remount and remain excluded from persistence, model context, queue preview, archive/search, and ContextScrollbar committed history.
- Canonical `runtimeState` drives active display with legacy busy fallback only when runtime state is absent.
- Queue previews remain a separate render-only timeline and never enter committed messages.

## Viewport behavior

- Streaming follow is an explicit latch. Upward wheel/keyboard/touch/scrollbar intent detaches before a token/layout update can undo it.
- Only actual-bottom tolerance or the bottom action re-enables follow.
- Remount state is in-memory by canonical session ID: either `bottom` or a stable committed-message anchor plus pixel offset.
- Restoration can expand the full timeline, uses idempotent row-offset correction, retains native browser scroll anchoring, and is cancelled by new user scroll input.
- A ResizeObserver reapplies active bottom/anchor state for late layout changes.
- Desktop reserves a 32px context-overview gutter inside the native message scroller: the track is positioned at the scroll container's outer right edge while the inner timeline content reserves 32px on its right, so message cards do not run beneath it. The shell is transparent over the timeline while the track retains its semantic scrollbar surface. The overview represents full committed history even while Chat initially mounts only the newest timeline rows. Its custom pointer interaction requests a native-container scroll and uses the existing explicit-user-intent latch; it never creates a second scroll owner or writes during passive geometry updates.
- `contextScrollbarModel.ts` owns browser-safe message estimate text, stable logical segments, tool-response-to-preceding-call row association, and real-usage-plus-tail context accounting. It uses the shared lightweight estimator and the latest persisted model-message input/cache/output usage as its real anchor; later committed content is estimated. `ContextScrollbar` uses rendered committed-row anchors and interpolation for the viewport marker plus one-shot DOM/token click and drag placement.

## Other behavior

- Header state and cwd come from the per-session history/stream snapshot, including in Code leaf Chat.
- Debug view fetches the session debug file payload on demand only after Debug is opened. Mount and ordinary history refresh never request the debug route; the history snapshot field feeds both the visible snapshot card and ContextScrollbar.
- History/SSE/Debug/CTX image parts use authenticated deployment-relative blob API paths and contain no base64 or legacy filesystem path. Timeline rendering owns the safe-raster/download distinction; canonical persistence/provider/retention behavior is [image blob lifecycle](../threads/image-blob-lifecycle.md).
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

[2026-07-27] Desktop Chat hides only the native message scrollbar chrome and reserves a real 32px context overview inside the native message scroller: the track is positioned at the scroll container's outer right edge and the inner timeline content reserves 32px on its right, preventing message cards from running beneath the overlay. The sticky overlay is a real descendant of the native timeline scroll container, preserving browser wheel/trackpad inertia and overscroll chaining rather than forwarding synthetic deltas. The existing message element remains the sole browser scroll container and mobile does not mount overview runtime observers. The overview stack immediately covers all committed non-temporary history, while its viewport marker progressively uses mounted stable rows. The persistent snapshot has a dedicated ContextScrollbar-only DOM boundary anchor (shared with its snapshot segment), so both viewport edges can interpolate within an expanded snapshot; generic Chat viewport persistence continues to exclude synthetic rows. A right-click `Vertical scale` menu persists one browser-local choice: Token count, Token count (logarithmic), or Rendered height, plus independent `Show scrollbar` and `Show minimap` checks. The default is minimap-only; the last enabled option cannot be disabled, and persisted both-false settings normalize back to minimap-only. Enabling the system scrollbar restores native scrollbar chrome while preserving a separately usable minimap, and the global settings menu also exposes Show minimap as a reliable re-enable path. Token modes use semantic token slice weights (linear or `log1p(tokens / 32)`); Rendered height uses measured stable-row DOM heights when available and semantic card/prose wrapping estimates for hidden lazy rows, replacing estimates as rows mount. Bars, viewport geometry, and click/drag mapping use the same selected scale. Free provider capacity is shown only in token modes. Without a valid persisted usage/capacity anchor, free space is explicitly unknown rather than inferred. When a native viewport edge lies below the final committed row, its thumb boundary extends into free context at the same token-per-pixel density as the message portion already framed by that viewport; trailing composer/blank layout never makes all free context appear visible. The exact logical viewport span is a translucent black overlay thumb in light mode and white in dark mode; both retain the same stronger rest, intermediate pressed, and brighter hover hierarchy. The thumb itself is square in every style and does not inherit the track's rounded-left or 550A geometry. The overview shell is 0.5 opacity at rest, full opacity on hover/focus and while dragging; its thumb alone holds a reliable `.47` intermediate fill while pressed/dragged even after pointer capture leaves the thumb. Click/drag targets are solved once from the measured DOM/token mapping: starting outside a thumb holds its center under the pointer; starting inside preserves the pointer's fractional vertical position within the thumb even if its measured height changes. Navigation still uses the native container and existing explicit-user-intent path. The overview estimates all model-visible parts, including lightweight metadata and RAG-marked text; display-only (`modelVisible:false`) stable rows retain zero-length navigation boundaries so they cannot remove the thumb. The info legend lists estimated occupied-token categories in this order: system prompt snapshot, system events, tool calls, user prompts, model reasoning, model contents, then free context. With valid provider usage/capacity in token modes, occupied category percentages are scaled to the visual used share and free tokens/percentage occupy the remaining capacity share, so the legend totals 100%; every known row formats as `x.xK (n%)`, including sub-1K values and free context. Otherwise free is explicitly `unknown` rather than a measured zero. Rendered-height mode keeps provider free capacity unknown. Model-contents slices (including CTX-BLOCK summaries) and their legend swatch use the ordinary assistant card surface in every theme, while reasoning remains distinct. A model row may emit adjacent anchored reasoning/content/tool slices; immediate tool responses stay folded into the tool-calls slice with final status tone. Orphan responses remain independent. Do not couple the overview to queued, nested, synthetic streaming, or collapse-state timelines.

## Canonical ownership

Per-session versus global stream ownership is canonical in [D-webui-session-stream-ownership](../modules/webui.md#d-webui-session-stream-ownership). History/debug bootstrap ownership is canonical in [D-webui-history-bootstrap](../modules/webui.md#d-webui-history-bootstrap). Optimistic identity and stale-history reconciliation are canonical in [D-streaming-optimistic-message-identity](../threads/streaming-pipeline.md#d-streaming-optimistic-message-identity).
