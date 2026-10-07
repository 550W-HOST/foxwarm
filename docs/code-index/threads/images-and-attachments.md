# Thread: Images, attachments, and file delivery

## Producer to consumer path

```text
WebUI upload / tool file reference / canonical Session message
  -> WebUIChannel.Files/Images + FileDelivery/ImageBlobStore
  -> canonical blob/reference metadata
  -> Session authority/image externalization
  -> ProviderImageParts + model adapter transport
  -> model stream/tool result or authenticated WebUI download
```

- **Producer:** WebUI upload routes, local file/delivery tools, and canonical message builders provide bounded bytes or image refs. They validate size/MIME/path before storage.
- **Owner:** `ImageBlobStore` owns canonical blob identity/reference and cleanup; `RasterCodec`/`HeifDecoder` normalize bytes; `ImageTransport` owns API conversion; `FileDeliveryDefinitions` owns authenticated delivery metadata.
- **Durable boundary:** Session JSON stores validated image reference/metadata; canonical blobs live under the data-root image store; model request/journal preparation stores only bounded/provider-safe references. Archive message rows preserve canonical message JSON, not arbitrary filesystem paths.
- **Consumers:** provider adapters hydrate/deduplicate image parts; WebUI renders `ImageParts` and downloads through host-authenticated routes; file delivery clients receive deployment-relative URLs/receipts.

## Ordering and failure behavior

`WebUIChannel.Images`/`Files` creates or resolves canonical blobs before returning a reference. `PersistentSessionAuthorityStore.LoadAsync` externalizes supported inline image parts through the image store; missing/invalid required blobs fail according to strict caller policy and do not silently rewrite active history. Provider adaptation can deduplicate a repeated blob without deleting the canonical source.

A transport ref is not a blob authority; a successful browser upload is not a model-turn commit. File delivery and image routes retain Session/agent ownership and normal HTTP auth. Vector/image search is not part of current .NET history admission; `VECTOR_DISABLED` remains explicit.

## Canonical units and tests

- [Images unit](../units/images.md)
- [Local file/delivery tools](../units/tools-local-io.md)
- [WebUI files/images](../units/dotnet-webui-files-images.md)
- `ImageBlobStore*Tests`, codec/pipeline/identity tests, file-delivery tests, and provider image tests.
