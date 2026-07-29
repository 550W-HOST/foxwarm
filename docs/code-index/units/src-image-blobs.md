# Unit: src-image-blobs

Files: src/imageBlobs.ts, src/imageBlobs.test.ts, src/imageBlobsSession.test.ts, src/imageBlobsLazySession.test.ts

## Purpose

Owns content-addressed image blob storage, inline/legacy-reference materialization, canonical message and queue conversion, safe blob path/MIME resolution, integrity validation, and provider-boundary hydration.

## Key exports

- `putImageBlob` — validates raster content when applicable and atomically stores bytes by SHA-256 plus safe extension.
- `resolveImageBlobPath`, `getSafeRasterMimeType` — validate blob identifiers and resolve storage/inline-render policy.
- `readImageRef` — reads canonical blobs or compatible legacy archive paths with size/hash checks.
- `externalizeMessageImages`, `externalizeMessages` — clone messages while replacing top-level, nested structured function-response, and legacy image data with canonical references.
- `externalizeQueueItemImages`, `externalizeQueueItems` — apply the same boundary to queued and managed-inbox work.
- `hydrateMessagesForProvider` — clones canonical messages and attaches inline base64 only for provider serialization.

## Behavior

- Blob IDs are `<sha256>.<extension>` and live under a hash-prefix shard in `state/image-blobs` (or the configured data directory).
- Writes use an exclusive temporary file and atomic rename; existing content is reused after size validation.
- PNG, JPEG, GIF, and WebP bytes are probed with `sharp` and must match their declared MIME type. Other formats are retained as download-only blobs.
- New message image IDs prefer existing metadata, then stable message sequence/part identity, then a UUID for transient queue items.
- Structured `functionResponse.response.inlineData` and `inlineDataItems` images are removed only after all blob writes succeed and are promoted immediately after their response as sibling reference parts carrying the same `tool_use_id`; business response fields and image order remain stable.
- Conversion functions do not mutate input messages. Callers update canonical state only after every requested conversion succeeds.
- Legacy path reads are confined to the configured state directory.

## Dependencies

- `src/config.ts` for the data-directory blob root.
- `src/types.ts` for messages, parts, references, and queue items.
- `sharp` for raster validation and dimensions.

## Tests

- Atomic deduplication, traversal rejection, MIME/byte validation, nested single/multiple promotion, idempotence, lazy legacy import, provider/tool association, failure preservation, live/archive/queue persistence, and fork reference preservation.

## Design decisions

Canonical ownership is [D-image-blob-canonical-lifecycle](../threads/image-blob-lifecycle.md#d-image-blob-canonical-lifecycle).
