# Main input-image prerequisites

The .NET host supports image input, not image generation, cropping, exporting or generic file delivery. The original WebUI composer uploads images; native `read` and recognized official MCP SDK image content enter the same durable blob lifecycle. Provider preparation hydrates a clone for Responses HTTP/WS, Chat Completions or Anthropic-compatible Messages.

## Raster input

`Foxwarm.csproj` pins `SkiaSharp` and `SkiaSharp.NativeAssets.Linux.NoDependencies` to **4.153.1**. NuGet restore and publish provide that raster dependency. The qualified runtime is Linux x64 with .NET 10. PNG, JPEG, GIF and WebP header/pixel limits are checked before pixel allocation. GIF contributes its first frame. The Source input limit is `64 * 1024 * 1024` pixels; provider optimization proportionally targets at most `4 * 1024 * 1024` pixels and a 4096-pixel longest side.

The selected Skia encoder has its own disposable cache policy identity; encoded bytes are not claimed identical to Source's encoder. Original canonical/download bytes are never replaced by provider variants.

## Optional HEIC/HEIF input

HEIC decoding requires **libheif 1.23.5** with the **libde265 1.1.3** HEVC decode chain. This is an explicit native runtime prerequisite, not an implicit system-library fallback or a managed NuGet codec. The narrow C-API adapter checks Linux x64, both exact versions, required symbols, decoder availability and the supported ABI. It selects the `libde265` decoder explicitly.

The adapter changes only the context's `max_image_size_pixels` to the existing Source limit before reading the container or decoding coded pixels. All other native security limits remain enabled. Managed primary dimensions, decoded plane dimensions/stride and allocation bounds are also checked; these are additional checks, not a substitute for the native coded-size limit. Default image transformations and the primary image are retained, including real alpha.

To reproduce the qualified decode-only build, use a caller-owned directory and installed C/C++ compiler, CMake, pkg-config, curl, tar and sha256sum:

```sh
bash dotnet/build-image-decoder.sh "$PWD/.temp/image-decoder"
LD_LIBRARY_PATH="$PWD/.temp/image-decoder/prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm
```

The script verifies pinned source-archive SHA-256 values and builds only the declared decode chain without global installation, plugin loading or encoders. It does not configure shared loader paths, package native binaries into the repository or establish a cross-platform deployment system. Keep the declared libraries available to the actual host process, including a published host outside the checkout. Changing `LD_LIBRARY_PATH` after a process has loaded the decoder does not requalify that process; use a fresh process for prerequisite changes.

A missing, incompatible or decoder-less prerequisite produces a visible **local image-preparation error before provider I/O**. It does not trigger retry, failover or provider-health penalties. A cached HEIC variant cannot bypass the prerequisite check. PNG and other raster input do not load HEIF and remain usable without it. HEIC downloads preserve original bytes and are served as attachments rather than a fabricated browser preview.

## Upstream source and licensing

- SkiaSharp 4.153.1: https://www.nuget.org/packages/SkiaSharp/4.153.1 and matching https://www.nuget.org/packages/SkiaSharp.NativeAssets.Linux.NoDependencies/4.153.1 . Upstream package notices apply.
- libheif 1.23.5: https://github.com/strukturag/libheif/tree/v1.23.5 . See upstream `COPYING` and `libheif/api/libheif/heif_security.h`; libheif uses LGPL licensing.
- libde265 1.1.3: https://github.com/strukturag/libde265/tree/v1.1.3 . See upstream `COPYING`; libde265 uses LGPL licensing.

The narrow C-API binding does not remove native-library license obligations. This work does not commit or redistribute those native libraries. Production promotion or redistribution needs a separate licensing and packaging review, including the relevant upstream notices and source requirements.

## Persistence and scope

New canonical history, queued parts and immutable Archive rows contain verified content-addressed references only after blob publication succeeds. Old inline/path images are read lazily from the accessed owner or transport clone; failed materialization leaves old content unchanged. Original blobs and legacy originals have no automatic garbage collection because retained Archive/fork references can outlive a live Session.

New identity move intent is version 2 and retains legacy Session image directories. Version 1 recovery keeps its original directional artifact behavior. Already completed old moves with missing legacy paths are not repaired or reconstructed. Other identity, JSON, Archive and fork-cap contracts remain unchanged.

See the canonical [Main input-images contract](../docs/code-index/units/dotnet.md#main-input-images) for staging authorization, safe browser transport, provider-only hydration, call association, request-local deduplication and remaining non-goals.
