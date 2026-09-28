# Unit: src-llm-openai-images

Files: src/llmProviders/openaiImages.ts, src/llmProviders/openaiImages.test.ts

## Purpose

Owns the OpenAI Responses hosted `image_generation` tool declaration and converts completed provider image items into canonical image message parts. It validates provider image bytes, persists them as content-addressed blobs, returns result-free native replay metadata for the originating concrete model, and provides the bounded user-visible text helpers used when native replay or generation is unavailable.

## Key Exports

- `OPENAI_IMAGE_GENERATION_TOOL_TYPE` / `OPENAI_IMAGE_GENERATION_CALL_ITEM_TYPE` — provider tool and output-item type constants
- `buildOpenAIImageGenerationTool(config?)` — maps an effective normalized config to the provider tool object; returns `undefined` when disabled and always sends `partial_images: 0`
- `externalizeGeneratedImageItems(outputItems, { sourceModelId })` — validates and persists each completed image call, returning successful `MessagePart`s and bounded failure records
- `decodeStrictImageBase64(value, maxDecodedBytes)` — strict, non-lossy base64 decoding with a decoded-size bound
- `sanitizeImageGenerationOutputItem(item)` — non-destructively copies only allowlisted replay fields and drops binary fields
- `buildImageGenerationReplayItem(item, resultBase64)` — builds one complete same-model `image_generation_call` replay item from safe metadata plus locally verified bytes
- `isImageGenerationCallItem(item)` / `isCompletedImageGenerationItem(item)` — output-item classification
- `deriveGeneratedImageId(callId?, index)` — bounded, path-safe generated image identity
- `formatGeneratedImageFailureNote(failures)` / `formatGeneratedImageModelPlaceholder()` — bounded user-visible text helpers
- `GeneratedImageReplayError` — raised when persisted generated-image bytes cannot be replayed, so callers can classify the failure as local and non-retryable instead of a provider or transport error
- `IMAGE_GENERATION_MAX_DECODED_BYTES` / `IMAGE_GENERATION_MAX_RESPONSE_BYTES` / `IMAGE_GENERATION_MAX_IMAGE_ITEMS` / `IMAGE_GENERATION_MAX_META_TEXT_CHARS` — local limits
- `GeneratedImageFailure`, `NormalizedGeneratedImage`, `NormalizedGeneratedImages`, `GeneratedImageMime` — result types

## Behavior

- **Declaration**: the tool object contains only provider-supported fields (`type`, optional `model`/`action`/`size`/`quality`/`background`/`output_format`/`output_compression`, plus `partial_images: 0`). Foxwarm's own `enabled` flag is never emitted, and no default image model or size is invented.
- **Acceptance**: only `image_generation_call` items with status `completed` and a non-empty `result` produce an image. The declared `output_format` must agree with the detected raster MIME, and the bytes must round-trip through strict base64 validation within both the per-image decoded and cumulative response limits.
- **Persistence**: each accepted image becomes one canonical `MessagePart` with an `inlineDataRef` (blob id, MIME, byte length, SHA-256, and pixel dimensions when the blob probe can read them), `imageMeta.origin = "generated"`, and `providerMeta.openaiResponses.outputItem` holding only allowlisted, result-free native metadata. Provider base64 never enters canonical history.
- **Failure handling**: a rejected image yields a bounded failure record instead of fabricated bytes and is never silently converted into a successful blank result.
- **Placeholder**: `formatGeneratedImageModelPlaceholder` is the single bounded note used when a different concrete model or protocol cannot receive native generated-image replay.

## Dependencies

- `../imageBlobs` — blob persistence, reference reads, raster probing, and MIME resolution
- `../common` — `logger`

## Design decisions

### D-llm-image-generation-tool-declaration

[2026-09-19] Hosted image generation is declared as a Responses tool object built only from the effective normalized config. Foxwarm does not hardcode a default hosted image model, size, or enablement field, so provider defaults stay authoritative and a future provider field can be adopted without a schema migration.

### D-llm-image-generation-binary-boundary

[2026-09-19] Provider image base64 is accepted only inside `externalizeGeneratedImageItems`, which validates the bytes, writes a content-addressed blob, and reduces the item to a reference plus safe metadata. Replay needs the same concrete model and locally verified bytes; a missing or unreadable blob is an explicit failure, never a dangling native call id or a silent regeneration.

### D-llm-image-replay-local-failure

[2026-09-19] A generated image that cannot be replayed from local storage raises `GeneratedImageReplayError` rather than a generic error. The failure is local, so it is reported as non-retryable and non-countable against model health: the provider was not asked for anything, retrying cannot restore the bytes, and a failover could pay twice for the same image. Canonical history is never rewritten to work around it.
