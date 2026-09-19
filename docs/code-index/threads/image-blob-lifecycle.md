# Thread: image blob lifecycle

## Overview

Cross-module lifecycle for image bytes from transient ingress through canonical session/archive persistence, provider requests, image tools, authenticated WebUI transport, and retained archive lifetime.

## Flow

1. Channels, including the authorization-gated QQ Bot C2C/group media
   materializer, MCP/node tools, and tool results may carry base64 as transient
   ingress or wire data. QQ generic files remain saved descriptors rather than
   image parts.
2. Before a message or queue item is durably written, `src/imageBlobs.ts` validates supported raster bytes, writes a content-addressed blob under the data directory, and replaces top-level `inlineData`, structured function-response `inlineData`/`inlineDataItems`, or a legacy archive path with sibling `inlineDataRef.blobId` parts plus stable tool association metadata.
3. Session history, queue/managed inbox, SQLite archive rows, forks, and compacted archive lineage keep references rather than duplicate base64.
4. Each concrete attempt filters model-specific history, reads and verifies original image blobs, then hydrates and optimizes only a provider-request clone for OpenAI Responses, OpenAI Chat Completions, or Anthropic. Density or dimension limits select a single WebP (or configured JPEG/transparent PNG) encoding; GIF always contributes its first frame, and HEIC/HEIF decodes to pixels before that same single encoding. A small deletable disk cache keyed by original bytes and conversion policy avoids repeat probes and encodes. Same-model native `image_generation_call.result` replays original bytes, whereas a later tool-result use of that image is ordinary vision input. Each physical request then deduplicates identical final provider-visible image bytes/MIME. Request diagnostics redact hydrated payloads.
5. WebUI history, message SSE, CTX-BLOCK expansion, and explicit Debug responses recursively remove inline bytes and legacy image paths, exposing only transport-safe references with deployment-relative authenticated blob API paths. Unmaterializable legacy images carry explicit unavailable metadata. The browser renders only safe raster MIME types inline.
6. `image_crop` and `image_write_to_file` resolve current blob references while retaining old inline/path readers. A trusted passed current-session owner searches its live history and then reads that session's canonical archive directly; legacy and other-session calls retain the compatible ID-based lookup. Master-local writes reuse the passed image bytes and existing path/isolation checks, while remote transfer remains on the existing node-manager path.
7. A provider-hosted image result enters the same lifecycle from the outbound side. A completed Responses `image_generation_call` is validated against its declared format and size limits, written as one content-addressed blob, and reduced to a reference-only part with safe native metadata. The bytes are never written to session history, the request journal, logs, WebUI transport, or error diagnostics; only the blob reference is durable, and the same concrete model reads the blob back when a later turn replays the image for editing.

## Compatibility and failure behavior

- There is no eager startup-wide migration. Accessing a legacy live session lazily imports valid inline/path images and persists references when possible.
- Legacy inline bytes and archive path references remain readable. Materialization failures leave the old persisted bytes intact; browser transport omits unavailable image bytes rather than returning base64.
- Blob writes use temporary files plus atomic rename and content identity. A failed write never replaces a canonical message with a partial reference.
- Provider hydration is clone-only; it never mutates or writes hydrated base64 back into canonical state. Cache failure or removal only causes recomputation, not a changed blob; no cleanup process scans the canonical blob store.
- Inline image deduplication is also clone-only and request-local. Retry and virtual/failover attempts start with a fresh seen set after concrete-model history compatibility filtering; protocol-dropped images do not seed it.
- Malformed, unsupported, or over-64-megapixel claimed HEIC/HEIF content fails during provider hydration before an HTTP request is sent.

## Retention and current non-goals

Retained archives may outlive live session deletion, so the first release performs no automatic blob garbage collection. History pagination, thumbnails/variants, partial or progressive image preview, archive-wide rewrite/purge, service-worker/IndexedDB caching, and automatic blob GC remain outside this boundary.

## Modules and units

- [image blob store](../units/src-image-blobs.md)
- [session manager](../units/src-session-manager.md)
- [session archive](../units/src-session-misc.md)
- [LLM request layer](../units/src-llm.md)
- [OpenAI image generation tool](../units/src-llm-openai-images.md)
- [tool image utilities](../units/src-tool-utils.md)
- [WebUI channel](../units/src-channels-webui.md)
- [WebUI timeline](../units/webui-chat-timeline.md)

## Design decisions

### D-image-blob-canonical-lifecycle

[2026-07-29] Durable session history, queued work, managed inboxes, and archive records use canonical content-addressed image blob references, not inline base64. Base64 remains permitted only as transient channel/tool/node/MCP ingress and as server-side provider-request hydration. Hydration clones messages at the provider boundary and request diagnostics must redact hydrated image payloads.

WebUI history, message SSE, CTX-BLOCK expansion, and explicit Debug output never return image base64 or legacy filesystem paths. They expose authenticated deployment-relative blob URLs. Only PNG, JPEG, GIF, and WebP are rendered directly; active or otherwise unsafe formats are download-only/unavailable and served with `nosniff`.

Compatibility is read-old/write-new and lazy per accessed live session, not a full startup migration. A materialization failure keeps old bytes intact. Automatic garbage collection is deferred because retained archives outlive live session deletion; v1 retains blobs for archive lifetime.

[2026-08-18; updated 2026-09-19] Canonical HEIC/HEIF blobs retain original MIME/bytes. At the clone-only provider boundary they are validated and decoded once within the existing 64-megapixel input limit, then encoded using the same selected output as other vision images. Native PNG, JPEG, and WebP under both optimization triggers pass through; GIF always converts its first frame. No SVG or unknown image conversion is added.

### D-image-provider-request-optimization

[2026-09-19] Provider-request image optimization runs after concrete-model history compatibility filtering, but before request-local deduplication and protocol serialization. Source bytes are SHA-256-keyed before image decode; canonical references and archive/session/WebUI/download data remain unchanged. The byte threshold is strictly greater than `min(1,000,000, 96*1024 + 0.5*oriented first-frame pixels)`; either more than `4*1024*1024` pixels or a side longer than `4096` independently forces proportional downscale without cropping or enlarging. GIF always takes the first frame. Default WebP quality 80 preserves alpha at alpha quality 100; the global `llm.providerImageOutputFormat: jpeg` chooses JPEG quality 80 unless real transparency needs PNG and converts existing WebP even below thresholds for endpoints without WebP support. One output encode per image: when only density triggers, a result no smaller than the original may pass through; mandatory resize, GIF frame selection, format compatibility, or HEIC conversion retains its output even when over 1,000,000 bytes. The size threshold is not an output cap.

Derived disk cache lives apart from `image-blobs`, records pass-through outcomes without copying source bytes, validates its own entries, and coalesces same-key process-local work. It has a 512 MiB soft cap, trims to 384 MiB on an eligible write-triggered scan no more often than every ten minutes across workers, and skips caching an entry over 32 MiB. Hits never scan the directory. A process-exit-safe best-effort cleanup lease avoids concurrent worker scans; temporary overshoot is allowed. Cache damage or unavailable storage recomputes safely; original blob integrity checks still run before cache lookup. A matching Responses concrete model's native generated-image replay instead reads verified original bytes unchanged; only ordinary vision positions (including generated bytes later surfaced as a tool image) are optimized. Each attempt derives fresh history from canonical state, and local preparation failures occur outside transport retry/failover health classification.

### D-image-provider-request-dedup

[2026-09-01] Within one physical provider request, OpenAI Responses, OpenAI Chat Completions, and Anthropic-compatible serialization send identical provider-visible normalized image bytes and MIME only at the first occurrence which that protocol actually serializes. Later occurrences keep their call/result association and model-visible placeholder: a corresponding canonical `foxwarm-image` descriptor gains `deduplicated="true"`, while tool-image guidance or a bounded fallback marker states that identical bytes appeared earlier in the request and were already read. The marker never exposes blob IDs, hashes, or paths beyond existing descriptor fields.

Identity hashes the exact current provider-visible decoded bytes and normalized MIME at the request boundary with a bounded input limit. Different provider-visible MIME values remain distinct, and HEIC/HEIF identity is therefore computed after provider-safe normalization. Duplicate status is held only in an internal side table, not in enumerable message fields. Legacy reserved helper keys are ignored and scrubbed during read-old/write-current externalization. Eligibility follows each serializer, so an image the protocol drops cannot seed the seen set.

This is an attempt-local provider-clone transform after concrete-model history compatibility filtering. Every retry or virtual/failover physical attempt starts fresh. Canonical Session history, queues, archives, blob references, diagnostics redaction, and WebUI transport remain unchanged. Before the canonical pre-hydration request journal is written, the request-local clone also strips the same unsupported reserved helper keys so legacy/forged values cannot enter reconstruction.

### D-image-generated-output-replay

[2026-09-19] A provider-hosted generated image becomes durable state through the same blob boundary as every other image: bytes in, reference out. Request logs, response logs, raw-stream capture, the request journal, WebUI transport, and error diagnostics carry only the reference and safe native metadata.

Native replay is allowed only for the exact concrete model that produced the image and only when the local blob bytes are readable. Another concrete model or protocol receives one bounded text note, and an unreadable blob is an explicit failure rather than a dangling native call id or a silent regeneration. The physical request that a generated image can reach also disables raw content capture, since the raw stream would otherwise be a second, unredacted copy of the same bytes.

The originating model does not fall back to the bounded placeholder when its own stored bytes are unreadable, because that would silently turn a user's edit instruction into a request against an absent image and could produce a plausible-looking result for the wrong artifact. The turn fails as a local, non-retryable error instead: the provider was never asked for anything, so no retry, failover, or duplicate generation is justified. The bounded placeholder is reserved for models and protocols that could never receive the bytes.
