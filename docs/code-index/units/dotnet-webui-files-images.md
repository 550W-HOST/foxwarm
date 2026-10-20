# Unit: WebUI files, images, and uploads

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Files.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Images.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiUploadedFiles.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiDownloadSignatures.cs`

## Purpose

Validates upload/download/image requests and delegates canonical blob, file-delivery, Session attachment, and provider-safe image operations.

## Stable methods and callers

`WebUIChannel.Files` resolves bounded deployment-relative paths and file-delivery references through `SessionManager.FileDelivery`; `Images` resolves canonical refs/inline parts through `ImageBlobStore` and converts transport; `WebUiUploadedFiles` owns multipart/temporary upload lifecycle and limits. Shared `ChannelFileNames` in [external channels](./dotnet-external-channels.md) owns storage naming and escaped descriptor grammar; Telegram does not reuse the browser staging/admission path.

## Contract and side effects

Normal HTTP auth and Session/agent ownership checks precede file/image effects. Browser-visible URLs are authenticated deployment-relative routes, not local paths. Upload success creates/returns a staged file descriptor; it does not imply active Session history or model-turn commit. Unsupported/missing image data is reported explicitly to the image/model boundary.

Multipart upload first stages bytes under `Path.GetTempPath()/foxwarm-uploads` on Main, using the Source random basename plus original extension. This is OS-temporary staging, not instance state or backup authority. The upload route retains the existing inclusive 50 MiB **per-file** admission; it does not derive an aggregate multipart body cap from that number. Scoped identity/Session ownership and revocation remain in the existing in-memory access owner. Normal preparation consumes/deletes the staged source; abandoned files follow OS temporary-storage policy without a new scanner, migration or cleanup service. Message preparation transfers an isolated/bound Agent's attachments to its actual Node and returns that Node/path in descriptors and partial saved-file results; ordinary non-isolated ingress retains Main storage regardless of selected execution Node. Canonical image blobs, authenticated downloads, Session history and Archive stay Main-owned. Administrator target selection does not impersonate a model tool caller or require its Node read/write grants. See the [file consumers unit](./external-node-files.md).

`WebUiDownloadSignatures.Issue`/`Verify` implement the [download capability contract](../modules/webui.md#d-webui-download-capabilities) with the Source HMAC format and 15-minute lifetime. Its fixed string/null array uses `JsonStringQuoting.Append` for JSON.stringify-compatible supplementary Unicode, lowercase control escapes and string escaping, without changing general authority serialization or journal bytes. Administrator-only `POST /api/download/sign` and `POST /api/blobs/{blobId}/download` return action-local relative URLs and expiry. `HttpServer` accepts ordinary credentials or a verified capability only on GET/HEAD endpoints marked with `WebUiDownloadResource`; global/path issuance, other methods and unrelated API routes retain the normal administrator gate. Scoped Session-blob issuance uses its own live scope/reference boundary. An invalid signature never overrides valid credentials. Global blob routes remain administrator-only unless an independent resource signature authorizes the read. Session blob routes validate active or committed effective Archive image references for scoped users, and scoped continuous image URLs retain the committed sequence. The Session route ID occupies the existing Source MAC namespace slot. Valid grants outlive ordinary identity revocation; issuance and reference checks are owned by [shared access](./dotnet-access-identities.md).

The WebUI file-delivery adapter remains registered during ApplicationStopping so accepted owners can settle; ApplicationStopped releases it after the shared host drains owners.

Path downloads retain regular-file/open-handle checks and streaming disposal. Filename overrides sanitize separators/control characters and limit the disposition name to 255 characters. Path previews are inline only for PNG/JPEG/GIF/WebP extensions; active/unknown files remain attachment/octet-stream. Blob display retains safe-raster MIME, immutable caching and existing authenticated URLs; explicit `preview=0` requests an attachment with the original name, while legacy authenticated `download=1` remains readable. GET/HEAD preserve content length and `nosniff`, without an authentication redirect. Relative issuance responses preserve nested deployment prefixes.

## Tests

`AsrRoutesTests.Uploads.cs` covers actual temporary upload/preparation, the multipart file/body boundary and scoped ownership/revocation; `WebUiUploadedFilesTests.cs`; `ImagePipelineTests.cs`; `ImageCodecTests.cs`; `ImageIdentityGuidanceTests.cs`; file-delivery and upload limit tests; `packages/webui/test/experimentHostNodeFiles.e2e.mjs` qualifies original remote picker ingress, canonical images and tool-row downloads through real hosts/CLI clients.

`WebUiDownloadTests` covers Source-produced emoji/control/escaping MAC agreement and verification, expiry/rotation/resource binding, real cookie-less GET/HEAD, credential-or-signature behavior, protected issuance/unrelated routes, sanitized names, safe/unsafe previews and a nested prefix. `packages/webui/test/experimentHostContinuousDownloads.e2e.mjs` uses the built original App and real host routes, removes cookies before releasing signing responses, and completes native file and archived-image downloads.
