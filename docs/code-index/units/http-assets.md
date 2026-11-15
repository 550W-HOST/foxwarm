# Unit: Packed and loose HTTP resources

Files: `dotnet/Foxwarm/HttpAssets.cs`, `scripts/asset-pack.mjs`, `scripts/asset-pack.test.mjs`, `dotnet/Foxwarm.Tests/Channels/HttpAssetsTests.cs`

Integration references: [host ingress](./host-runtime.md), [Code resources](./code-services.md), [delivery graph](./core-delivery-cli.md#build-and-resource-boundary), [release packages](./release-packages.md).

## D-http-asset-pack

**User decision (2026-11-15): consolidate HTTP-only resources into an asset pack in server and Desktop packages.** WebUI dist/login, first-party Code extensions and the optional Code OSS distribution are HTTP resources. Code's runtime `node_modules`, built-in extensions and YAML resources belong in the pack too: browser module URLs, extension manifests and webview resources all reach Main's HTTP routes. This reduces the small-file extraction and replacement cost without changing browser URLs or authorization.

Skills, templates, native libraries, ToolScript, the JS client/shared closure and the artifact compiler's React/ReactDOM/scheduler packages remain ordinary files. The compiler resolves and reads those libraries through Node/esbuild; they are not HTTP-only resources. Development and staged source publications keep loose resources. Existing extracted Code installations remain readable. Windows Desktop includes Code in its application pack; macOS Desktop keeps its existing optional-Code boundary.

**User decision (2026-11-15): store one representation per entry.** Compressible entries use Brotli alone, retaining original length and the original-byte SHA-256 for HTTP validation. Main streams decompression when the client does not accept Brotli; it does not cache decompressed output. Already-compressed formats and entries with insufficient savings stay raw. Raw entries support Range; Brotli entries may return the complete body with status 200. Gzip and identity duplicates are not stored.

## Format and builder

`FWASSET1` is an eight-byte format/version marker, followed by an unsigned little-endian 64-bit index length, a UTF-8 JSON object `{entries: {path: entry}}`, and concatenated data. Offsets are relative to the data section. Each entry records `offset`, stored `length`, `originalLength`, original-byte `sha256`, `contentType`, and optional `encoding: "br"`. Relative slash paths have no empty, dot, dot-dot, backslash, colon or control-character components. The reader validates paths, extents, types and encoding before exposing data; the index is bounded at 64 MiB.

The format is owned here because consumers need HTTP streams, not Node require/filesystem transparency. `writePack` sorts the namespace deterministically, rejects symlinks and duplicate keys, spools data and writes the small index ahead of it. Text, JSON, XML, WebAssembly and SVG of at least 1 KiB are candidates. Brotli quality 9 is a build-time choice; a result must save at least 5% plus 64 bytes. Runtime-adapted index/manifest/workbench/pre HTML resources use the same original-byte reader before their existing transformations.

`node scripts/asset-pack.mjs build OUTPUT [--code]` creates application resources. `inspect PACK` prints its index. `extract PACK EMPTY_DIRECTORY` restores original bytes and verifies their hashes; an empty destination avoids following pre-existing extraction links. `codeSources` supplies the optional distribution to the release producer.

## Serving and installation

`HttpAssets` reads `foxwarm.assets` under its resource root, falling back to loose paths for absent entries. The separate Code pack is installed at `<application-root>/packages/vscode-web/assets/foxwarm.assets`; its keys use the same `packages/vscode-web/assets/` namespace as the application pack. Payload Code takes precedence over this stable optional installation. Ordinary runtime replacement therefore preserves separately installed Code.

`Open`, `Exists`, `ReadTextAsync` and `ServeAsync` serve all consumers, including Code readiness, built-in extension resources and the capability-protected webview pre route. Built-in extension descriptors are compiled into the upstream workbench; Main does not discover them by enumerating filesystem directories. Existing runtime JavaScript/HTML patches and dynamic WebUI manifest/index headers remain with their route owners.

Each response holds its own shared-delete file handle and bounded positional stream; no whole-pack load or shared seek cursor participates. An in-flight response keeps the old file across replacement. Only the parsed index is cached, refreshed on file length/modification changes; a newly installed optional pack is visible without restarting Main. Brotli decompression is streamed through `BrotliStream`. Encoded responses carry stored length; decoded responses carry original length. `Vary: Accept-Encoding` covers both. ETags derive from original hashes; Brotli entries use weak validators across encoded and decoded representations, while raw entries use strong validators. ASP.NET owns conditionals, HEAD and raw single-range handling. Packed responses bypass runtime compression, including decoded responses, so they are not immediately recompressed as gzip.

The abstraction retains loose serving for ordinary development and old installations. It does not virtualize filesystem consumers or expose new public routes. Authentication, deployment prefixes, capability checks and no-store dynamic transformations precede or surround resource serving in their existing owners.

## Tests

The writer tests cover deterministic single-representation output, original metadata, extraction, traversal, duplicate/symlink input refusal, extent validation and original-content verification. `HttpAssetsTests` runs actual HTTP requests through the compression middleware for loose/packed range parity, ETag/304, HEAD, negotiation, decoded length, non-recompression, malformed paths/extents and live replacement with an old response still open. `mainHostCodeResources.e2e.mjs` checks actual JavaScript token colors and the built-in Markdown webview, refusing required-resource HTTP failures. The original Code/WebUI browser fixtures and package qualification exercise cross-language writer/reader interoperability through the delivered resources.
