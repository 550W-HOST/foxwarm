# Unit: Image blobs, codecs, transport, and provider parts

Files: `dotnet/Foxwarm/Images/HeifDecoder.cs`, `dotnet/Foxwarm/Images/ImageBlobStore.Provider.cs`, `dotnet/Foxwarm/Images/ImageBlobStore.cs`, `dotnet/Foxwarm/Images/ImageTokenEstimate.cs`, `dotnet/Foxwarm/Images/ImageTransport.cs`, `dotnet/Foxwarm/Images/ProviderImageDedup.cs`, `dotnet/Foxwarm/Images/RasterCodec.cs`

## Purpose

Stores canonical image blobs, probes/decodes raster and HEIF data, converts API transport forms, deduplicates provider payloads, and estimates image tokens.

## Stable methods and callers

- `ImageBlobStore` owns canonical blob paths, session references, cleanup/export, and hydration of inline/ref image parts.
- `RasterCodec.Probe/Decode` and `HeifDecoder` normalize dimensions, MIME/orientation, transparency, and encoded variants.
- `ImageTransport` registers JSON converters for image references/inline forms; `ProviderImageDedup` emits refs-only provider parts when a canonical image has already been sent; `ImageTokenEstimate` supplies bounded model cost estimates.

Callers: `WebUIChannel.Images/Files`, `PersistentSessionAuthorityStore.LoadAsync` image externalization, `ProviderImageParts`, Responses/Anthropic/Completions serializers, and file delivery.

## Contract and side effects

A transport reference is not itself an authority record: canonical blob identity and ownership remain in `ImageBlobStore`/Session metadata. Load externalization is tolerant for existing stored data where the current caller requests non-strict hydration; provider serializers must not mutate active history while adapting image parts. Browser URLs are authenticated host routes, not public filesystem paths.

## Tests

`dotnet/Foxwarm.Tests/Images/ImageBlobStore*Tests.cs`; `ImageCodecTests.cs`; `ImagePipelineTests.cs`; `ImageIdentityGuidanceTests.cs`; `ImageLegacyLifecycleTests.cs`.
