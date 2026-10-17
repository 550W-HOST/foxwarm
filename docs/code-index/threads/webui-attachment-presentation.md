# Thread: WebUI attachment presentation

## Scope

Display spans [composer](../units/webui-chat-composer.md) and [timeline](../units/webui-chat-timeline.md). Atomic serialization and draft/File ownership remain in [D-composer-inline-attachments](../units/webui-chat-composer.md#d-composer-inline-attachments); image URL/MIME authority remains in [image blob lifecycle](./image-blob-lifecycle.md).

## D-attachment-grid-and-inline-references

[2026-10-16] Desktop and mobile display image/file previews in a grid above the text area. The editor contains compact baseline-aligned `FILE 1`, `FILE 2` references instead of image cards. Pasted-text blocks remain inline. Grid numbers and FILE labels use the same current display order; surviving canonical `attachmentN` identities are never rewritten merely to update these labels.

`ComposerAttachmentGrid` owns thumbnail object URLs, revoking them on replacement/unmount. It does not own the File or a second draft. Preview and Remove delegate to the editor's imperative operations. Remove uses the same atomic mutation/undo boundary; missing Files retain reattachment behavior, and an attachment-only draft remains sendable. Failed upload/POST retains the draft; only acceptance clears it. Grid overflow is bounded on small screens.

Sent and queued user rows place the file grid above, outside, the user text bubble. Small FILE references remain at the authored positions inside text. Clicking an image reference uses the shared [full-screen viewer](#d-fullscreen-image-preview). Generated transport descriptor prefixes are hidden only when correlated with a matching real reference; pasted-text payloads are opaque to this matching. Legacy unassociated images still render. No persisted message or canonical clipboard source is rewritten by layout.

Queued preview transport can deliberately omit image bytes and supply a separate MIME placeholder part. A correlated placeholder is displayed as the attachment's Queued state, not as user prose or a fabricated image URL. Committed missing images use an unavailable state. Images with real data retain ordinary lazy loading, same-origin scoped URLs, unsafe-format download fallback, and contain-fit thumbnails that do not crop wide screenshots into an apparently blank tile.

## D-fullscreen-image-preview

[2026-10-16] Image thumbnails and inline FILE references open one shared full-viewport preview on desktop and mobile. Composer images, sent/received history and tool images, generated images and delivered reply images use the same native modal surface; clicking a preview never navigates to an image URL or opens another browser tab. The initial image fits without cropping. Actual size enables native scrolling for detailed inspection. Filename, Download and Close remain available outside the scrolling image area; safe areas are respected on narrow and landscape screens.

The native dialog traps focus, supports Escape/platform cancellation and restores the connected opener without scrolling. Clicking empty fit-mode background also dismisses it. Page scroll locks are reference-counted and restored on cleanup. Existing scoped authenticated blob URLs, editor-owned object URLs and reply download callbacks retain their ownership; the viewer grants no new file access and does not change history, uploads or draft/File identity. Only PNG/JPEG/GIF/WebP render inline. Unsupported formats stay download-only, and missing draft images retain the reattachment flow. Image/decode and download failures remain in the viewer instead of navigating to an error page. Implementation: [shared image preview](../units/webui-image-preview.md).

## D-reply-file-deliveries

[2026-10-16] Successful `send_file` deliveries addressed to the current Session or its exact WebUI target render in a compact, left-aligned reply file grid after that reply span, before queued previews and runtime status. Delivery appears immediately and follows later reply text without depending on process disclosure or completion. Desktop/mobile and all main timeline views share the surface; nested process timelines do not duplicate it. Each input-bounded reply span keeps its own files. The renderer creates no canonical message and fetches no extra history.

Only successful delivery receipts qualify, never arbitrary file writes, model-authored links, failures, or other destinations. The versioned, bounded [receipt DTO](../units/shared-file-delivery.md) carries a stable delivery ID, target, original name/MIME/size, source Node, and Main-owned download path. Remote files already use the existing Main cache; the current selected Node is not a download-routing authority. Delivery IDs deduplicate replays, not filenames. Old direct send records may use a paired send intent plus a structured absolute `fullPath`; the renderer never parses success prose or stdout and does not invent missing sizes. Underlying file retention is unchanged; this is not a new immutable file store or cross-Session inbox.

Safe raster files support lazy thumbnails and a keyboard-accessible preview with Download. Large known images skip automatic thumbnails. Other formats are download-only. The existing authenticated path-download gate is retained, including HEAD validation, original-name disposition, no-sniff raster-only inline responses, and attachment disposition for active formats. A missing/unavailable download reports an inline error without navigating away. Refresh and timeline-mode changes reconstruct file grids from loaded canonical records; source files can still become unavailable. Shared gallery keys preserve an open preview when a live reply finishes.

Implementation is owned by [reply files](../units/webui-reply-files.md), [file delivery](../units/src-file-delivery.md), and [WebUI channel](../units/src-channels-webui.md).

## Verification

`messageAttachmentDrafts.e2e.mjs` covers real built-CSS geometry, File identity, failed/accepted sends, desktop/mobile references, removal/undo, and active composition. `pastedTextBlocks.e2e.mjs` covers history grids, inline reference geometry, source metadata, duplicate names, MIME safety, quoted markers, and omitted queue previews. `composerPastedText.e2e.mjs` retains native caret, selection, composition, copy/delete, and undo coverage.

`replyFiles.test.mjs` covers receipt filtering, separate turns, legacy intent, ToolScript/unified returns, identity and bounded parsing. `replyFiles.e2e.mjs` covers main-view/viewport changes, reload, live ownership, native preview focus/Escape, and missing downloads. `webuiFileDownloads.test.ts` covers the unchanged auth gate, safe disposition/MIME/HEAD behavior, and missing paths; file-delivery service tests verify remote cache/source provenance.
