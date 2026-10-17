# Unit: WebUI reply files

Files: packages/webui/src/components/replyFiles.ts, packages/webui/src/components/ReplyFileGrid.tsx, packages/webui/test/replyFiles.test.mjs, packages/webui/test/replyFiles.e2e.mjs
Secondary files: packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/downloadShared.ts, packages/webui/src/index.css

## Purpose

Projects delivered assistant files into visible, input-bounded reply grids independently of tool disclosure. Canonical behavior and rationale belong to [D-reply-file-deliveries](../threads/webui-attachment-presentation.md#d-reply-file-deliveries).

## Public symbols and function index

- `buildReplyFileGroups(messages, sessionId)` — bounded receipt extraction, exact-target/success filtering, replay deduplication, legacy paired-intent compatibility, and source-span ownership. Recognizes direct/unified calls and structured ToolScript returns without reading stdout strings.
- `ReplyFile`, `ReplyFileGroup` — display records; legacy size is absent rather than fabricated.
- `ReplyFileGrid` — fixed-footprint, wrapping output file tiles, safe raster thumbnails/preview, and download-only generic files.
- `ReplyFileTile` — per-delivery thumbnail/error/download state; aborts pending signing requests on unmount and reports missing downloads without navigation.
- `buildPathDownloadUrl` / `requestPathDownloadUrl` / `triggerBrowserDownload` — deployment-prefixed canonical resource URLs, action-time authenticated signature issuance, and native browser handoff.
- Image previews delegate to the shared [full-screen image viewer](./webui-image-preview.md), retaining the tile-owned download callback and pending/error state.

## Integration

`SessionTimeline` maps source span ends to the last owning projected main row/group. Reply-file keys and delivery keys survive the arrival of final text; process/nested timelines suppress duplicate grids. Gallery metadata does not alter archive history or scroll-anchor identities. `downloadShared` constructs deployment-prefixed resource URLs and requests a fresh signed URL only when the user downloads; grants are not persisted in those records. The expanded tool download action reuses that issuance helper. Canonical authority and expiry: [D-webui-download-capabilities](../modules/webui.md#d-webui-download-capabilities). Source Node provenance is distinct from the Main cache that serves remote files.

## Verification

Pure tests cover current targets, failure/invalid metadata, distinct same-name deliveries, idempotent replays, separate inputs, legacy direct calls, and structured nested results. Built-CSS browser tests cover mobile/desktop, Conversation/Detailed/Grouped, reload, image loading, live final text with an open modal, focus/Escape and missing files. The browser fixture uses production HTTP signing/download routes, verifies a real cookie-less native download under a nested prefix, and covers the expanded tool download action.
