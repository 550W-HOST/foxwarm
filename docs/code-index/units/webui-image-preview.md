# Unit: WebUI image preview

Files: packages/webui/src/components/ImagePreviewDialog.tsx
Secondary files: packages/webui/src/components/ImageParts.tsx, packages/webui/src/components/InlineComposerEditor.tsx, packages/webui/src/components/ReplyFileGrid.tsx, packages/webui/src/index.css, packages/webui/test/imageParts.e2e.mjs, packages/webui/test/messageAttachmentDrafts.e2e.mjs, packages/webui/test/replyFiles.e2e.mjs

## Purpose

Shared full-viewport image viewer for draft images, user/history/tool images and delivered reply images. Interaction is governed by [D-fullscreen-image-preview](../threads/webui-attachment-presentation.md#d-fullscreen-image-preview); URL/MIME authority remains with the original source.

## Symbols

- `ImagePreviewDialog` — client-only portal into a native modal dialog, keyed by source URL so a changed image resets its view without resetting an unchanged live preview.
- `isSafeImagePreviewMime` — shared PNG/JPEG/GIF/WebP allowlist used by the viewer and its callers.
- `Preview` — fit/actual-size state, image load/error feedback, native cancellation and source-preserving download actions.
- `lockPageScroll` — reference-counted document scroll lock, restoring the previous root/body overflow after the last shared viewer closes.

## Integration

`ImageItem` retains scoped authenticated blob URLs and legacy inline-data handling. The composer borrows its existing editor-owned object URL and never owns another File or edits the draft. Missing draft files retain the existing reattachment dialog. `ReplyFileTile` supplies its original download callback, pending/error state and Main-cache URL, keeping HEAD/disposition validation and remote provenance unchanged. All use the same viewer rather than opening image URLs in another tab.

The native top layer escapes pane clipping and provides keyboard focus containment. Close/Escape restores the connected opener with preventScroll. Images fit without cropping; actual size enables native scrolling for detailed inspection. Closing aborts viewer-owned requests, while the reply tile remains responsible for its own download request. Active formats are not rendered inline.

## Verification

`imageParts.e2e.mjs` uses real built CSS and authenticated nested-path URLs to check full viewport geometry, image containment, focus, Escape/backdrop, scroll-lock cleanup, no popup/navigation, download and unsafe-format fallback. `messageAttachmentDrafts.e2e.mjs` covers composer entry points and retained File/ref/undo semantics. `replyFiles.e2e.mjs` retains live-grid/modal identity, download errors and focus restoration.
