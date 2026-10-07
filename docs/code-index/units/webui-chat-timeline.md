# Unit: Chat timeline, message rendering, and tool cards

Files: `packages/webui/src/components/ChatTimeline.tsx`, `packages/webui/src/components/ContextBlockCard.tsx`, `packages/webui/src/components/ContextScrollbar.tsx`, `packages/webui/src/components/ImageParts.tsx`, `packages/webui/src/components/MarkdownHtmlSegment.tsx`, `packages/webui/src/components/ModelThreadCard.tsx`, `packages/webui/src/components/ProcessingStatus.tsx`, `packages/webui/src/components/ReasoningCard.tsx`, `packages/webui/src/components/SpecialBlock.tsx`, `packages/webui/src/components/SyntaxHighlightedText.tsx`, `packages/webui/src/components/ThreadLineButton.tsx`, `packages/webui/src/components/ToolExecText.tsx`, `packages/webui/src/components/ToolScriptProgressContext.tsx`, `packages/webui/src/components/ToolTimelineItems.tsx`, `packages/webui/src/components/WebSearchCard.tsx`, `packages/webui/src/components/contextScrollbarModel.ts`, `packages/webui/src/components/legacyEditCounts.ts`, `packages/webui/src/components/markdownRenderer.ts`, `packages/webui/src/components/menuPositioning.ts`, `packages/webui/src/components/mermaidPolicy.ts`, `packages/webui/src/components/timelineRows.ts`, `packages/webui/src/components/timelineTime.ts`, `packages/webui/src/components/useThreadCardHeightTransition.ts`, `packages/webui/src/components/useThreadCardOverflowFade.ts`, `packages/webui/src/contextScrollbarSettings.ts`, `packages/webui/src/usageTiming.ts`, `packages/webui/src/utils/languages.ts`, `packages/webui/src/webSearchAction.ts`

## Purpose

Renders canonical message parts, context blocks, reasoning, images, tool executions, Markdown/mermaid policy, hosted web-search activity, and bounded timeline/viewport state.

## Stable symbols and callers

`ChatTimeline`; `timelineRows`; `ToolTimelineItems`; `markdownRenderer`; `mermaidPolicy`; `ModelThreadCard`; `SpecialBlock`; `WebSearchCard`; context scrollbar/overflow helpers. Callers are `Chat`, session replay/realtime payloads, and shared tool-rendering helpers.

## Behavior and side effects

`timelineRows.ts` is the canonical row derivation boundary: it decides grouping, summary tags, aggregate usage/timing, and row identity; non-groupable rows keep `group: null`. Tool, Reasoning, heavy System/Event, and CTX-BLOCK cards share the compact 18px header rhythm while retaining distinct semantic tone/surface allocation. A persisted user-role event wrapper belongs to an existing tool run; it does not create a standalone run.

Horizontal overflow is owned by the native outer Chat message scroller. Message content, model/tool/system cards, fenced code, tables, and context blocks remain shrinkable; tables may scroll in their own box and code wraps without silently hiding content. Viewport restoration anchors only rendered top-level committed rows, excluding queued/archive previews and synthetic streaming rows.

Hosted Responses `web_search_call` cards render only proven persisted action shapes in original model-part order. They are reasoning-like model artifacts, not Foxwarm tool invocations: unknown/malformed hosted items stay hidden in rendered mode while JSON view retains original metadata, and the separate Sources/URL annotation surface remains independent.

## Tests

Timeline/message rendering, special-block, tool-card, Markdown/mermaid, overflow, and hosted-response/WebSearch browser tests.
