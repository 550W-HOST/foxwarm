# Thread: image blob lifecycle

## Overview

Cross-module lifecycle for image bytes from transient ingress through canonical session/archive persistence, provider requests, image tools, authenticated WebUI transport, and retained archive lifetime.

## Flow

1. Channels, MCP/node tools, and tool results may carry base64 as transient ingress or wire data.
2. Before a message or queue item is durably written, `src/imageBlobs.ts` validates supported raster bytes, writes a content-addressed blob under the data directory, and replaces top-level `inlineData`, structured function-response `inlineData`/`inlineDataItems`, or a legacy archive path with sibling `inlineDataRef.blobId` parts plus stable tool association metadata.
3. Session history, queue/managed inbox, SQLite archive rows, forks, and compacted archive lineage keep references rather than duplicate base64.
4. Provider requests clone canonical messages and hydrate referenced bytes only while building OpenAI Responses, OpenAI Chat Completions, or Anthropic payloads. Request diagnostics redact those hydrated payloads.
5. WebUI history, message SSE, CTX-BLOCK expansion, and explicit Debug responses recursively remove inline bytes and legacy image paths, exposing only transport-safe references with deployment-relative authenticated blob API paths. Unmaterializable legacy images carry explicit unavailable metadata. The browser renders only safe raster MIME types inline.
6. `image_crop` and `image_write_to_file` resolve current blob references while retaining old inline/path readers.

## Compatibility and failure behavior

- There is no eager startup-wide migration. Accessing a legacy live session lazily imports valid inline/path images and persists references when possible.
- Legacy inline bytes and archive path references remain readable. Materialization failures leave the old persisted bytes intact; browser transport omits unavailable image bytes rather than returning base64.
- Blob writes use temporary files plus atomic rename and content identity. A failed write never replaces a canonical message with a partial reference.
- Provider hydration is clone-only; it never mutates or writes hydrated base64 back into canonical state.

## Retention and current non-goals

Retained archives may outlive live session deletion, so the first release performs no automatic blob garbage collection. History pagination, thumbnails/variants, provider output-image support, archive-wide rewrite/purge, service-worker/IndexedDB caching, and automatic blob GC remain outside this boundary.

## Modules and units

- [image blob store](../units/src-image-blobs.md)
- [session manager](../units/src-session-manager.md)
- [session archive](../units/src-session-misc.md)
- [LLM request layer](../units/src-llm.md)
- [tool image utilities](../units/src-tool-utils.md)
- [WebUI channel](../units/src-channels-webui.md)
- [WebUI timeline](../units/webui-chat-timeline.md)

## Design decisions

### D-image-blob-canonical-lifecycle

[2026-07-29] Durable session history, queued work, managed inboxes, and archive records use canonical content-addressed image blob references, not inline base64. Base64 remains permitted only as transient channel/tool/node/MCP ingress and as server-side provider-request hydration. Hydration clones messages at the provider boundary and request diagnostics must redact hydrated image payloads.

WebUI history, message SSE, CTX-BLOCK expansion, and explicit Debug output never return image base64 or legacy filesystem paths. They expose authenticated deployment-relative blob URLs. Only PNG, JPEG, GIF, and WebP are rendered directly; active or otherwise unsafe formats are download-only/unavailable and served with `nosniff`.

Compatibility is read-old/write-new and lazy per accessed live session, not a full startup migration. A materialization failure keeps old bytes intact. Automatic garbage collection is deferred because retained archives outlive live session deletion; v1 retains blobs for archive lifetime.
