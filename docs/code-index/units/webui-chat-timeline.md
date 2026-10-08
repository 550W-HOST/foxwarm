# Unit: WebUI Chat timeline

Files: `packages/webui/src/components/ChatTimeline.tsx`, `packages/webui/src/components/ToolTimelineItems.tsx`, `packages/webui/src/components/ReasoningCard.tsx`, `packages/webui/src/components/ContextBlockCard.tsx`, `packages/webui/src/components/PastedTextBlock.tsx`

## Purpose

Renders committed messages, queued previews, live model drafts, tool activity, reasoning, images, context blocks, and user-facing metadata.

## Behavior

Committed host messages remain authoritative. Streaming drafts and temporary rows are presentation state and reconcile without rewriting persisted history. Tool and markdown surfaces stay shrinkable; intentional wide output owns horizontal scrolling. Code links use resolved path metadata when supplied by the host.

## Tests

Timeline, streaming, tool-group, markdown, overflow, and ordered-response fixtures cover the supported rendering paths.
