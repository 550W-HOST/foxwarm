# Unit: src-image-blobs

Files: src/imageBlobs.ts, src/imageBlobs.test.ts, src/imageBlobsSession.test.ts, src/imageBlobsLazySession.test.ts, src/providerImageOptimization.ts, src/providerImageOptimization.test.ts
Secondary files: src/providerImageRequest.test.ts, src/testFixtures/synthetic-3x2.heic, src/testFixtures/synthetic-alpha-3x2.heic, src/testFixtures/README.md

## Purpose

Owns content-addressed image blob storage, inline/legacy-reference materialization, canonical message and queue conversion, safe blob path/MIME resolution, integrity validation, and provider-boundary hydration.

## Key exports

- `putImageBlob` — validates raster content when applicable and atomically stores bytes by SHA-256 plus safe extension.
- `resolveImageBlobPath`, `getSafeRasterMimeType` — validate blob identifiers and resolve storage/inline-render policy.
- `readImageRef` — reads canonical blobs or compatible legacy archive paths with size/hash checks.
- `externalizeMessageImages`, `externalizeMessages` — clone messages while replacing top-level, nested structured function-response, and legacy image data with canonical references.
- `externalizeQueueItemImages`, `externalizeQueueItems` — apply the same boundary to queued and managed-inbox work.
- `stripReservedProviderImageHelperFields` — removes legacy/forged provider-image helper keys from a request-local or persistence-bound message clone without mutating caller input.
- `hydrateMessagesForProvider` — reads verified canonical bytes into a provider-only clone and chooses per-concrete-attempt optimization or original-byte native image-generation replay.
- `optimizeProviderImage` — content/policy-keyed derived cache, image probing and first-frame/orientation handling, single output encoding and bounded write-triggered cleanup.

QQ Bot C2C/group image ingress uses the same transient `inlineData` path after
its authorization-gated media materializer validates the declared MIME and
bytes; it must not introduce a QQ-specific durable image format.

## Behavior

- Blob IDs are `<sha256>.<extension>` and live under a hash-prefix shard in `state/image-blobs` (or the configured data directory).
- Writes use an exclusive temporary file and atomic rename; existing content is reused after size validation.
- PNG, JPEG, GIF, and WebP bytes are probed with `sharp` and must match their declared MIME type. Other formats are retained as download-only blobs.
- New message image IDs prefer existing metadata, then stable message sequence/part identity, then a UUID for transient queue items.
- Structured `functionResponse.response.inlineData` and `inlineDataItems` images are removed only after all blob writes succeed and are promoted immediately after their response as sibling reference parts carrying the same `tool_use_id`; business response fields and image order remain stable.
- Conversion functions do not mutate input messages. Callers update canonical state only after every requested conversion succeeds.
- Legacy path reads are confined to the configured state directory.
- Provider hydration lazily loads `libheif-js` only for HEIC/HEIF, validates actual container/decoded pixels, and enforces the existing 64-megapixel limit before pixel decode. It gives raw pixels to the one output encoder (WebP by default, JPEG or PNG for transparent pixels in JPEG mode). PNG/JPEG/WebP below density and dimension triggers pass through; GIF always emits its first frame. The deletable, atomically written cache is separate from canonical blobs, keyed by original SHA-256 plus policy, and checks derived-byte integrity on read. Request-local deduplication hashes final inline bytes/MIME rather than original blob identity.
- Externalization strips legacy/reserved provider-image helper keys from every converted part, including already-reference-only parts, so those keys cannot enter canonical Session, queue, archive, or WebUI source shapes. Low-level LLM requests apply the same pure scrub to their structured-cloned canonical request before journaling.
- Provider-generated output images use the same store: the hosted Responses image path validates the provider bytes, writes one content-addressed blob per accepted image, and records a reference-only part with `imageMeta.origin = "generated"`. Identical bytes from two separate generations share one blob while each native call record is preserved, and replay reads the blob back rather than trusting provider payload bytes.

## Dependencies

- `src/config.ts` for the data-directory blob root.
- `src/types.ts` for messages, parts, references, and queue items.
- `sharp` for raster validation and dimensions.
- `libheif-js` for in-process HEVC-backed HEIF/HEIC provider normalization.

## Tests

- Atomic deduplication, traversal rejection, MIME/byte validation, nested single/multiple promotion, idempotence, lazy legacy import, provider/tool association, HEIC/HEIF alias normalization and malformed-input rejection, below-threshold still-image pass-through, GIF first frame, cache hit/corruption/cleanup, provider-only optimization, native replay preservation, failure preservation, live/archive/queue persistence, and fork reference preservation.

## Design decisions

Canonical ownership is [D-image-blob-canonical-lifecycle](../threads/image-blob-lifecycle.md#d-image-blob-canonical-lifecycle).
