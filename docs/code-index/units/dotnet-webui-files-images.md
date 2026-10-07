# Unit: WebUI files, images, and uploads

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Files.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Images.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiUploadedFiles.cs`

## Purpose

Validates upload/download/image requests and delegates canonical blob, file-delivery, Session attachment, and provider-safe image operations.

## Stable methods and callers

`WebUIChannel.Files` resolves bounded deployment-relative paths and file-delivery references through `SessionManager.FileDelivery`; `Images` resolves canonical refs/inline parts through `ImageBlobStore` and converts transport; `WebUiUploadedFiles` owns multipart/temporary upload lifecycle and limits.

## Contract and side effects

Normal HTTP auth and Session/agent ownership checks precede file/image effects. Browser-visible URLs are authenticated deployment-relative routes, not local paths. Upload success creates/returns a blob/reference; it does not imply active Session history or model-turn commit. Unsupported/missing image data is reported explicitly to the image/model boundary.

## Tests

`WebUiUploadedFilesTests.cs`; `ImagePipelineTests.cs`; `ImageCodecTests.cs`; `ImageIdentityGuidanceTests.cs`; file-delivery and upload limit tests.
