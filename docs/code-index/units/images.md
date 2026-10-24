# Unit: Image blobs, codecs, transport, and provider parts

Files: `dotnet/Foxwarm/Images/HeifDecoder.cs`, `dotnet/Foxwarm/Images/ImageBlobStore.Provider.cs`, `dotnet/Foxwarm/Images/ImageBlobStore.cs`, `dotnet/Foxwarm/Images/ImageTokenEstimate.cs`, `dotnet/Foxwarm/Images/ImageTransport.cs`, `dotnet/Foxwarm/Images/ProviderImageDedup.cs`, `dotnet/Foxwarm/Images/RasterCodec.cs`, `dotnet/Foxwarm/Images/ImageInputPolicy.cs`, `dotnet/Foxwarm/Images/TiffMetadata.cs`

## Purpose

Stores canonical image blobs, probes/decodes raster and HEIF data, converts API transport forms, deduplicates provider payloads, and estimates image tokens.

## Stable methods and callers

- `ImageBlobStore` owns canonical blob paths, session references, cleanup/export, and hydration of inline/ref image parts.
- Shared [native primitives](./dotnet-node-primitives.md) own `RasterImageMime.Detect`, which recognizes PNG/JPEG/WebP/GIF/BMP from at most twelve header bytes without decoding or validating the file. Native/provider file reads and hosted Responses image classification share it; hosted generation still excludes BMP.
- `RasterCodec.Probe/Decode` and `HeifDecoder` normalize dimensions, MIME/orientation, transparency, and encoded variants.
- `ImageTransport` registers JSON converters for image references/inline forms; `ProviderImageDedup` emits refs-only provider parts when a canonical image has already been sent; `ImageTokenEstimate` supplies bounded model cost estimates.

Callers: `WebUIChannel.Images/Files`, `PersistentSessionAuthorityStore.LoadAsync` image externalization, `ProviderImageParts`, Responses/Anthropic/Completions serializers, and file delivery.

## Contract and side effects

A transport reference is not itself an authority record: canonical blob identity and ownership remain in `ImageBlobStore`/Session metadata. Load externalization is tolerant for existing stored data where the current caller requests non-strict hydration; provider serializers must not mutate active history while adapting image parts. Browser URLs are authenticated host routes, not public filesystem paths. Externalized MCP image occurrences retain their per-image `annotations` and `_meta` beside the reference, including the native ToolScript projection; audio and binary resources are not routed to an image decoder.

`ImageInputPolicy` shares byte-first admission between browser preparation and visual provider hydration: strictly more than 32 MiB or 64 × 1024 × 1024 pixels is file-only. Raster and HEIF metadata probing precedes pixel conversion; a bounded first-directory TIFF/BigTIFF dimension reader covers the generic upload preflight without adding TIFF pixel decoding or provider format conversion; byte-over-limit input needs no decoder. Canonical raster storage probes dimensions without the vision cap, retaining original bytes and image IDs. Provider-only fallback replaces an existing image descriptor with a file descriptor on its actual Node, or retains an actionable image ID without exposing private blob paths or creating/transferring a file. Tool fallbacks are placed in the matching existing function-response occurrence so all three serializers preserve them. Canonical history, authority JSON and Archive are unchanged by hydration.

Unreadable, out-of-scope or corrupt ordinary-vision references still fail before file fallback. Unvalidated legacy inline payloads retain the previous serializer-owned behavior. Native generated-image eligibility is decided before reading a referenced original: a producer-shaped assistant generated part with known source/destination concrete keys retains its reference and provenance, without inline bytes, when the destination cannot perform native Responses replay. Existing serializers emit the bounded no-image-content/local-ID guidance. Exact-concrete Responses replay still reads and verifies the original, while later ordinary tool vision remains byte-first. Other nonvisual assistant inputs keep their existing protocol-specific validation, including HEIF checks, rather than becoming new file transfers. HEIF metadata uses the existing pinned native decoder owner without allocating an RGBA plane; its other native container safety limits remain in force.

## Tests

`dotnet/Foxwarm.Tests/Models/GeneratedImageReplayAdmissionTests.cs` exercises normal generated output, canonical authority/Archive append, exact-concrete and alias replay, foreign Responses/Completions placeholder requests after owned blob deletion, originating-model no-send failure, and same-key protocol reconfiguration through the normal configuration owner against a loopback peer.

`dotnet/Foxwarm.Tests/Images/ImageBlobStore*Tests.cs`; `ImageCodecTests.cs`; `ImagePipelineTests.cs`; `ImageIdentityGuidanceTests.cs`; `ImageLegacyLifecycleTests.cs`; `VisionInputParityTests.cs` and its actual Source oracle `dotnet/Foxwarm.Tests/Fixtures/vision-input-fixture-ts.mjs` compare genuine over-byte/over-pixel images, descriptors, tool-result placement, serialization and canonical persistence.

The optional decode-chain build and licensing prerequisites are documented in `docs/native-image-prerequisites.md`; the helper is `dotnet/scripts/build-image-decoder.sh`.
