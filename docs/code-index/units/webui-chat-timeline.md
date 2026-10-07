# Unit: Chat timeline, message rendering, and tool cards

Files: `packages/webui/src/components/ChatTimeline.tsx`, `packages/webui/src/components/ContextBlockCard.tsx`, `packages/webui/src/components/ContextScrollbar.tsx`, `packages/webui/src/components/ImageParts.tsx`, `packages/webui/src/components/MarkdownHtmlSegment.tsx`, `packages/webui/src/components/ModelThreadCard.tsx`, `packages/webui/src/components/ProcessingStatus.tsx`, `packages/webui/src/components/ReasoningCard.tsx`, `packages/webui/src/components/SpecialBlock.tsx`, `packages/webui/src/components/SyntaxHighlightedText.tsx`, `packages/webui/src/components/ThreadLineButton.tsx`, `packages/webui/src/components/ToolExecText.tsx`, `packages/webui/src/components/ToolScriptProgressContext.tsx`, `packages/webui/src/components/ToolTimelineItems.tsx`, `packages/webui/src/components/WebSearchCard.tsx`, `packages/webui/src/components/contextScrollbarModel.ts`, `packages/webui/src/components/legacyEditCounts.ts`, `packages/webui/src/components/markdownRenderer.ts`, `packages/webui/src/components/menuPositioning.ts`, `packages/webui/src/components/mermaidPolicy.ts`, `packages/webui/src/components/timelineRows.ts`, `packages/webui/src/components/timelineTime.ts`, `packages/webui/src/components/useThreadCardHeightTransition.ts`, `packages/webui/src/components/useThreadCardOverflowFade.ts`, `packages/webui/src/contextScrollbarSettings.ts`, `packages/webui/src/usageTiming.ts`, `packages/webui/src/utils/languages.ts`, `packages/webui/src/webSearchAction.ts`

## Purpose

Renders canonical message parts, context blocks, reasoning, images, tool executions, Markdown/mermaid policy, and search cards.

## Stable symbols and callers

`ChatTimeline`; `timelineRows`; `ToolTimelineItems`; `markdownRenderer`; `mermaidPolicy`; message-part cards.

Callers and boundary: `Chat`; session replay/realtime payloads; shared tool rendering helpers.

## Behavior and side effects

`ChatTimeline` consumes bounded replay and realtime rows; `timelineRows` preserves assistant/tool/reasoning/context ordering. Tool/image/context cards render typed payloads, while Markdown/mermaid/syntax helpers apply safe rendering policy and truncation. A streamed row can be provisional until the host sends the committed revision.

## Tests

Markdown, special-block, overflow, timeline, tool-card, and message rendering tests.
