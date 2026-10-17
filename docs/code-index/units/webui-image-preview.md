# Unit: WebUI image preview

Files: packages/webui/src/components/ImagePreviewDialog.tsx
Secondary files: packages/webui/src/components/downloadShared.ts, packages/webui/src/components/ImageParts.tsx, packages/webui/src/components/InlineComposerEditor.tsx, packages/webui/src/components/ReplyFileGrid.tsx, packages/webui/src/index.css, packages/webui/test/imageParts.e2e.mjs, packages/webui/test/messageAttachmentDrafts.e2e.mjs, packages/webui/test/replyFiles.e2e.mjs

## Purpose

Shared full-viewport image viewer for draft images, user/history/tool images and delivered reply images. Interaction is governed by [D-fullscreen-image-preview](../threads/webui-attachment-presentation.md#d-fullscreen-image-preview); URL/MIME authority remains with the original source.

## Symbols

- `ImagePreviewDialog` — client-only portal into a native modal dialog, keyed by source URL so a changed image resets its view without resetting an unchanged live preview.
- `isSafeImagePreviewMime` — shared PNG/JPEG/GIF/WebP allowlist used by the viewer and its callers.
- `Preview` — fitted/intrinsic image sizing, bounded touch pinch/pan state, image load/error feedback, native cancellation and source-preserving download actions.
- `requestImageDownloadUrl` — resource-specific authenticated signature issuance for global/Session blobs, with local `blob:`/`data:` passthrough.
- `lockPageScroll` — reference-counted document scroll lock, restoring the previous root/body overflow after the last shared viewer closes.

## Integration

`ImageItem` retains scoped authenticated blob URLs and legacy inline-data handling. The composer borrows its existing editor-owned object URL and never owns another File or edits the draft. Missing draft files retain the existing reattachment dialog. `ReplyFileTile` supplies its download callback, pending/error state and Main-cache URL; it requests an action-local path-download signature while retaining server-side file validation and remote provenance. Remote image-blob download actions request a fresh signature using the original global or Session blob route; local `blob:`/`data:` downloads stay local. Unsafe-format attachment download buttons also obtain a signature before native download and keep errors inline. Ordinary displayed image URLs remain unsigned and credential-protected. Authority and lifetime are canonical in [D-webui-download-capabilities](../modules/webui.md#d-webui-download-capabilities). All use the same viewer rather than opening image URLs in another tab.

The native top layer escapes pane clipping and provides keyboard focus containment. Close/Escape restores the connected opener with preventScroll. Images fit without cropping; actual size uses intrinsic image pixels and enables native scrolling for mouse/keyboard inspection. Touch pointers captured on the original image/stage target support midpoint-anchored pinch zoom and one-finger scrolling when enlarged, including a remaining finger after pinch. Zoom is bounded between fit and the larger of intrinsic size or eight times fit. Only the image surface handles gestures; page touch zoom/scroll is disabled there. Moved, multi-touch and cancelled gestures suppress their trailing click without disabling the next deliberate tap or toolbar action. Resize observation updates fitted geometry without changing an enlarged image's pixel scale. Closing aborts viewer-owned requests, while the reply tile remains responsible for its own download request. Active formats are not rendered inline.

## Verification

`imageParts.e2e.mjs` uses real built CSS and authenticated nested-path URLs to check full viewport geometry, image containment, focus, Escape/backdrop, scroll-lock cleanup, no popup/navigation, native cookie-less signed image download, safe filename/MIME/disposition, and unsafe-format signed attachment fallback. Chromium native touch input additionally checks off-center pinch anchoring, pinch-in to fit, pinch-to-one-finger continuation, independent pan/cancellation, trailing-click suppression, deliberate subsequent taps, unchanged source/page viewport and intrinsic sizing through rotation. This is mobile browser emulation, not physical iOS evidence. `messageAttachmentDrafts.e2e.mjs` covers composer entry points and retained File/ref/undo semantics. `replyFiles.e2e.mjs` retains live-grid/modal identity, download errors and focus restoration.
