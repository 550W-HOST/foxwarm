# Unit: webui-chat-timeline

Files: packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/ContextBlockCard.tsx, packages/webui/test/messageWidth.e2e.mjs, packages/webui/test/usageBadgeDetails.e2e.mjs
Secondary files: packages/webui/src/chatViewportState.ts

## Purpose

Renders a chat conversation as a vertical timeline of message bubbles, handling user messages, model responses (with markdown), tool call/response grouping, token usage badges, system-like messages, reasoning cards, and image parts. It supports collapsible tool groups, copy-to-clipboard, and responsive mobile/desktop layouts.

## Key Exports

- `ChatTimeline` — default export, the main timeline component
- `getMessageStableKey(msg, idx)` — shared helper in `chatViewportState.ts` that generates a stable React key for a message
- `getMessageViewportAnchorKey(message)` — returns a stable viewport identity for non-temporary committed rows
- `ContextBlockCard` — renders CTX-BLOCK model messages as tool/reasoning-style thread cards with local expand/collapse state and the read-only WebUI archive expansion endpoint
- `getContextBlockMetaFromMessage(message)` — pure helper that prefers structured `__meta.contextBlock` metadata and falls back to parsing legacy CTX-BLOCK text only when needed

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `getMessageStableKey(msg, idx)` | ~28–34 | Produces a stable key from message metadata or index |
| `getMessageViewportAnchorKey(message)` | `chatViewportState.ts` | Produces a context-block/seq/id/timestamp anchor key while excluding temporary/synthetic rows. |
| `toTokenCount(value)` | ~67 | Safely coerces a value to a finite number or null |
| `normalizeMessageUsage(value)` | ~71–84 | Normalizes various token usage shapes into a standard format |
| `getModelMessageUsage(msg)` | ~86 | Extracts normalized usage from a model message |
| `getUsageTotalTokens(usage)` | ~88 | Sums all token fields |
| `formatTokenCount(count)` | ~92 | Formats a number as K/M shorthand |
| `formatUsageTitle(usage, callCount)` | ~103 | Builds a tooltip string for usage badge |
| `formatUsageModel` / `formatUsageTimes` | ~107–150 | Derive route attribution and stable local time/range text from persisted message metadata. |
| `ModelUsageRow` | ~155 | Renders a single labeled token count with color tone |
| `ModelUsageBadge` | ~165 | Accessible compact/expanded token badge with persisted route and time details. |
| `ModelUsageAnchor` | ~235 | Positions the usage badge and owns its local expanded state (mobile vs desktop layout). |
| `MarkdownContent` | ~138 | Memoized markdown-to-HTML renderer with link handling |
| `InlineMetaPart` | ~143 | Renders system text inline with reduced opacity |
| `CollapsibleUserText` | ~153 | User message text with expand/collapse for system content |
| `SystemLikeMessageCard` | ~181 | Card for system-like messages with collapsible body |
| `ModelMessageContent` | ~230 | Renders model message parts (text, reasoning, images, tool calls) |
| `UserMessageContent` | ~290 | Renders user message parts with collapsible/system handling |
| `CopyButton` | ~340 | Copy-to-clipboard button with checkmark feedback |
| `MessageRow` | ~370 | Full message row: layout, bubble styling, tool group logic |
| `ChatTimeline` | ~530 | Top-level component managing tool group expansion state and rendering |
| `ContextBlockCard` | `ContextBlockCard.tsx` | Tool/reasoning-style CTX-BLOCK thread card with shared `ToolTag`/`ThreadLineButton` primitives and local nested expansion state |

## Dependencies

- `./chatShared` — shared utilities (`renderMarkdown`, `formatToolLabel`, `isSystemLikeText`, `copyTextToClipboard`, `IconToggleButton`, types `Message`, `ToolTagItem`, `ViewMode`, etc.)
- `./ImageParts` — renders image content parts
- `./ReasoningCard` — collapsible reasoning/thinking display
- `./ToolTimelineItems` — `InterleavedToolGroup`, `ToolCallsBlock`, `ToolResponsesBlock`, `ToolGroupSummaryCard`, `getToolResponseStatus`

## Behavior

- Messages are keyed by synthetic id, meta id, timestamp, or fallback index for stable React reconciliation.
- Top-level rows backed by stable committed-message metadata expose `data-chat-message-anchor-key`; nested CTX-BLOCK rows and temporary/synthetic stream rows do not become viewport anchors. `Chat` scopes anchor lookup to the committed timeline so queued previews cannot replace a saved session position.
- Tool call and tool response messages are grouped: consecutive model (with functionCall) + tool pairs collapse into a summary card that can be expanded.
- Token usage is normalized across different provider schemas (OpenAI-style, Gemini-style) and displayed as a floating badge on model messages. Its unexpanded `×/C/I/O` presentation remains compact; the badge itself is the only interactive target and toggles an accessible in-place detail view. Details use persisted `__meta.timestamp`, concrete `__meta.modelId`, and optional virtual `__meta.virtualModelKey`, never the current session selection. Missing or invalid legacy metadata is shown as unavailable/invalid rather than inferred.
- A collapsed tool-group badge still aggregates token counts across provider calls. Its expanded attribution lists unique routes and an inclusive local-time range (with missing/invalid markers when applicable), so mixed calls are not falsely presented as the first route's metadata.
- System-like and collapsible messages get special card treatment with expand/collapse toggles. Inline user text rendering also checks each line with the shared system-like classifier so `<foxwarm-system ...>`, `<foxwarm-message ...>`, and `</foxwarm-message>` tag lines render as small metadata instead of normal Markdown/HTML, while body lines inside full wrappers render at normal text size. The classifier distinguishes real direct channel wrappers (`type="channel"`) and lightweight time/session metadata from heavy/non-direct wrappers (`type="inter-agent"`, `timer`, `trigger`, etc.), pure system event tags such as wait timeouts, and heavy snapshot/system-prompt tags, so non-channel/source/system events and synthetic persistent-memory snapshots render left through `SystemLikeMessageCard` instead of as right-aligned direct user bubbles.
- Model messages with `__meta.contextBlock` render as CTX-BLOCK thread cards, visually distinct from normal assistant bubbles but using the same `ToolTag` + `ThreadLineButton` pattern as tool/reasoning cards. The tag label is just `CTX-BLOCK`; the header line shows metadata (`B#`, level, raw sequence range, and time range when available). The summary markdown is rendered below the header like tool body content and clamped to three lines while collapsed. Clicking the collapsed surface or gutter expands; expanded cards show the full summary plus fetched children/raw messages and collapse via the left gutter or header. Expansion is local React state keyed to the card; switching sessions/reloading clears it and does not modify the `messages` array.
- CTX-BLOCK expansion has no mode switch: expanding fetches one layer. Block-backed blocks render child CTX-BLOCK messages that can be expanded recursively; message-backed/L1 blocks render their covered raw archive messages. Nested cards naturally create nested thread-line gutters matching tool/reasoning interaction.
- `MessageRow` decides layout (user right-aligned, model left-aligned), applies view-mode toggling (rendered vs source vs JSON), and conditionally shows copy buttons.
- User and assistant message surfaces expose semantic CSS hooks (`foxwarm-user-message-bubble`, `foxwarm-user-message-text`, `foxwarm-assistant-message-card`, `foxwarm-assistant-message-markdown`, `foxwarm-assistant-message-raw`) so opt-in UI style layers can restyle the timeline while preserving message grouping, Markdown sanitization, and view-mode behavior.
- Timeline rows/cards and nested assistant, Reasoning, and CTX-BLOCK flex surfaces use `min-width: 0`/bounded widths so intrinsic Markdown content cannot widen the message or viewport. Top-level desktop model/tool rows fill 80% of the timeline, while user messages remain content-sized up to 80%; mobile and nested model/tool rows fill their timeline, and nested user messages cap at 85%. The built-CSS contract fixture is `packages/webui/test/messageWidth.e2e.mjs`. The shared timeline/message-column boundaries also use horizontal-overflow clipping as defense in depth against a future malformed/oversized child; this does not remove nested scroll ownership from intentionally scrollable Markdown tables. Shared Markdown CSS breaks long prose tokens, wraps fenced code with preserved whitespace, and assigns horizontal scrolling only to wide tables; `packages/webui/test/messageOverflow.e2e.mjs` injects a deliberately oversized child.
- The component is heavily memoized (`memo`) to avoid re-renders on large conversations.

## Design Decisions

- [2026-07-24] The usage badge is the canonical interaction boundary for token detail disclosure. Preserve its existing collapsed compact labels, external desktop lower-right placement/gap, setting gate, and aggregate totals; on mouse/keyboard activation only the badge expands to full labels plus persisted time and routing attribution. Desktop expansion prefers that same external anchor and clamps left only by the amount needed to keep its right edge within the nearest timeline boundary; mobile remains flow layout. A virtual route is displayed as `virtual → concrete`; route/time metadata is never inferred from mutable UI state. For grouped calls, retain aggregation but show all unique routes and a time range rather than assigning the aggregate to one call.

- [2026-07-21] Model Markdown overflow behavior is shared across ordinary assistant cards, Reasoning, and CTX-BLOCK summaries: long prose may break, fenced code wraps without horizontal scrolling, and semantic tables scroll horizontally within their own box. Nested message/flex surfaces must be shrinkable rather than relying on a final overflow-hiding ancestor.
- [2026-07-22] The Chat message column, committed/queued timeline boundaries, and each shared `ChatTimeline` root must defensively clip horizontal overflow while preserving vertical flow. Keep `min-width:0`/`max-width:100%` at these boundaries. Intentional inner horizontal scrollers such as Markdown tables retain their own scrolling; do not apply this defense to global popovers/drag overlays.
- [2026-07-22] Preserve the longstanding responsive message-width contract from the initial WebUI: top-level desktop model/tool/system messages are `w-full` with a real 80% maximum; desktop user messages use intrinsic width with an 80% maximum; mobile model/tool messages and nested model/tool/system messages are full-width; nested user messages cap at 85%. The dynamic `widthClass` is the sole owner of the direct message wrapper's maximum width. Generic containment utilities must not add an unconditional `max-w-full` to that same element: Tailwind emits `.max-w-full` after `.max-w-[80%]`, silently overriding the 80% rule. Keep `min-w-0` on the wrapper and full-width/clipping containment on its outer row/timeline instead.

- [2026-07-14] Viewport restoration anchors only actual rendered, top-level committed message rows with stable metadata. Nested archive previews, queued previews, and temporary/synthetic streaming rows are excluded from persisted-in-memory viewport identity.
- [2026-07-06/2026-07-07] Chat timeline metadata styling is line-based for both old and new formats. Keep opening/closing foxwarm tag lines on their own lines and route them through `isSystemLikeText`/small `<pre>` rendering; body lines inside full wrappers should render at normal message text size. Do not let raw `<foxwarm-...>` lines fall into assistant Markdown rendering where DOMPurify/HTML parsing could alter them. Snapshot/system-prompt foxwarm-system tags, event tags such as wait timeouts, and non-channel foxwarm-message source wrappers are intentionally non-lightweight so they remain left-aligned/collapsible system cards like legacy non-direct `[SYSTEM:]` messages; `type="channel"` remains the direct-user/right-side case.

## Integration

- Consumed by a parent chat view that passes the `messages` array and display preferences (`isMobile`, `groupTools`, `showUsageBadge`).
- Also reused by the chat view for render-only queued preview messages returned separately from committed history; these previews are rendered in a separate `ChatTimeline` instance below the Processing bubble so tool grouping, truncation, and history state do not cross the committed/queued boundary.
- Requires the current `sessionId` prop for CTX-BLOCK expansion fetches: `GET /api/sessions/:sessionId/context-blocks/:blockId/expand`.
- Delegates tool rendering to `ToolTimelineItems` components which handle individual tool call/response display.
- Relies on `chatShared` for markdown rendering, link handling, and message classification utilities shared across the chat UI.
