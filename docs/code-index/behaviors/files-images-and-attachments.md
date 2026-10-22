# Behavior: files, images, and attachments

For developers and Agents changing attachment ingress, model image input, previews, or file delivery. Selecting a browser File, uploading bytes, saving a file, storing an image in history, showing a thumbnail, sending visual input to a model, and delivering a downloadable file are separate effects. Success at one boundary does not prove the others occurred.

## From draft to retained input

| Stage | Owned state and observable consequence |
| --- | --- |
| Compose | Ordered text, pasted-text blocks, and attachment references form one draft. Stable refs identify attachments; filenames and sequential FILE labels do not. No upload happens before Send. |
| Save browser draft | Local storage retains text and attachment metadata, not file bytes. Exact File objects remain in page memory by Session and ref across unmount/switch. Reload requires reattachment or removal before send. |
| Submit | The browser uploads the referenced Files, then posts the message with the returned locators. Only accepted submission clears that Session's draft/File ownership; upload or POST rejection retains them. An earlier successful upload is not itself [committed Session input](messages-and-turns.md#which-boundary-am-i-observing). |
| Ingest | The server saves each usable attachment and adds its descriptor. Ordinary images also contribute structured image input. Generic files contribute descriptors, not automatic document parsing or arbitrary file bytes in model input. |
| Persist image | Valid image bytes become canonical blob references before durable history/queue/archive writes. Browser transport uses authenticated references rather than base64 or legacy internal paths. |
| Prepare model request | A fresh concrete-model request clone reads eligible originals and prepares that protocol's visual input. It does not rewrite saved files, blobs, messages, or Archive. |

Atomic editing, copy/undo, reattachment, and accepted-clear details belong to the [composer contract](../units/webui-chat-composer.md#d-composer-inline-attachments). Transport descriptors retain their [Channel grammar](../modules/channels.md#d-channel-file-descriptor); browser reference correlation is presentation, not authorization.

### Storage does not follow every Node selection

Ordinary non-isolated WebUI attachment ingestion saves under the Agent's Main-side inbound-file storage even when the Session has selected a remote execution Node. Effective isolated destinations use their existing bound/current-Node file transfer path. The resulting descriptor's Node/path is the locator; the receiving Agent must not assume the current cwd contains the upload. Saving, [selecting a Node](nodes-workspaces-and-permissions.md#selection-routes-operations-not-the-whole-session), and granting access remain distinct.

The current WebUI upload cap is 1 GiB, not an assurance that every downstream destination accepts that many bytes. Existing CLI file transfer is whole-buffer and has its own lower transport ceiling; oversized-image fallback does not remove it. Per-file ingestion failures are logged and skipped while processing other parts. Thus the current message route can accept remaining text/attachments without an all-or-nothing attachment transaction; a successful message receipt is not proof that every supplied file became a descriptor. Source ownership and file preparation are in [WebUI ingestion](../units/src-channels-webui.md) and [Channel file handling](../units/src-channel-core.md).

Scoped WebUI uploads bind the temporary upload to the authenticated identity and Session before ingestion and recheck access. That grants no arbitrary Main-path ingestion or runtime-Agent file permission. Administrator routes retain their existing authority. See [scoped WebUI access](../modules/webui.md#d-webui-identity-session-scope).

## Original image, provider input, and browser preview are not the same object

The canonical image preserves original bytes and MIME, including supported HEIC/HEIF originals. Image IDs identify images in a Session's available history/archive; they are not paths, URLs, blob credentials, or proof that the current model received pixels.

| Representation | Contract |
| --- | --- |
| Saved attachment file | A filesystem resource at its recorded Node/path. It can later be read, copied, deleted, or delivered under ordinary permissions. |
| Canonical image blob | Verified original bytes referenced from retained messages, queues, archives, and fork lineage. Repeated references need not duplicate the bytes. |
| Provider clone | Hydrated and possibly converted/downscaled image input for one concrete physical request. Retry/failover starts from canonical state again. |
| Browser image | Safe raster preview obtained through the authorized blob route or an editor-owned local URL. Display is not provider replay. |
| Image-tool result | A new Session image with its own tool-result ID; crop produces another image, while `image_write_to_file` explicitly creates a file at an authorized destination. Neither implicitly delivers it. |

Optimization runs after concrete-model history compatibility selection and before request-local deduplication. Ordinary inputs may be proportionally downscaled without cropping/enlarging and encoded once in the effective provider-safe format. GIF contributes its first frame; HEIC/HEIF is decoded for provider input, not rewritten in canonical storage. Identical final image bytes/MIME are sent only at the first occurrence actually serialized in that request; later occurrences retain association and an explanatory placeholder. This is not global deletion or a claim that different models share the same image input. Exact thresholds, formats, and cache policy remain in [image preparation](../threads/image-blob-lifecycle.md#d-image-provider-request-optimization) and [deduplication](../threads/image-blob-lifecycle.md#d-image-provider-request-dedup).

### Oversized ordinary images are files, not reduced visual input

A source **strictly larger than 32 MiB** or **strictly above `64 * 1024 * 1024` pixels** is not sent as ordinary vision input. The byte gate precedes metadata probing; dimensions are checked before pixel decode/reencoding. Invalid or unsupported metadata is not itself evidence of oversize and retains the existing preparation error behavior.

| Where the decision happens | User/Agent consequence |
| --- | --- |
| New WebUI upload | Retains original bytes through ordinary file storage and emits a file descriptor, including file-only messages. It does not first make a huge image base64 payload merely to discard it. |
| Existing canonical image with an adjacent valid attachment descriptor | Only the provider clone changes the image descriptor to a file descriptor, preserving original name, Node, and path. The visible/history image remains an image. |
| Existing reference-only image | The provider gets an omission note with the actual image ID and `image_write_to_file` guidance. No internal blob path, fabricated file locator, or automatic cross-Node copy is supplied. |

The model can explicitly save a reference-only original by ID to an authorized file destination; target transfer limits still apply. The policy does not introduce a second attachment store or rewrite old history. Same-concrete generated-image native replay is the separate exception below. Canonical owner: [oversized vision as file](../threads/image-blob-lifecycle.md#d-image-oversized-vision-as-file).

## Generated images retain replay identity

A completed provider-hosted generated image enters the same canonical blob lifecycle. History, request journals, response diagnostics, and WebUI transport retain only references and safe native metadata, not another base64 copy.

- The exact concrete Responses model that produced it may replay the verified original bytes as its native generated-image call for later editing. That replay bypasses ordinary-vision optimization.
- Another concrete model/protocol receives an honest bounded no-image-content note and local-ID save/crop guidance, not a fabricated native call or silently substituted visual input.
- Missing or corrupt required original bytes fail locally rather than silently regenerating an image or treating an edit request as if the image were present.
- Using the image later as an ordinary tool image is ordinary vision input, with that path's optimization and oversize policy; native provenance is not copied into the tool image.

After a normal assistant append succeeds, successfully generated images are automatically delivered best-effort through eligible normal Channel attachments with file capability, even when the response has no text or continues with tools. Send-only and unsupported attachments are skipped. Delivery failure does not roll back history or rerun generation; there is no persisted delivery outbox or older-history replay sweep. This post-commit delivery is distinct from a model deciding to call `send_file`; destination selection follows [Channels and replies](channels-and-replies.md#where-should-the-agents-ordinary-reply-go). See [generated image replay and delivery](../threads/image-blob-lifecycle.md#d-image-generated-output-replay) and [tool image references](../units/src-tool-utils.md#d-tool-result-image-reference).

## Preview, download, and delivery have separate authority

Draft and timeline attachments use a grid plus compact FILE references at authored text positions. Images, tool images, generated images, and delivered reply images share the full-screen modal viewer: fit without cropping, actual-size scrolling, Download, Close, focus restoration, and touch inspection. Opening the viewer does not navigate away, alter the draft/history, or grant file access. Only PNG/JPEG/GIF/WebP render inline; other formats are download-only/unavailable. A queued MIME placeholder is shown as Queued, not as prose or a made-up image URL. See [attachment presentation](../threads/webui-attachment-presentation.md).

`send_file` explicitly prepares and delivers an existing file. Its optional Node selects the source, not the destination Channel's filesystem. Remote source bytes are prepared in Main's delivery cache; the receipt records source provenance and the actual Main download resource. Changing Session Node later must not reroute that download. Destination Session and exact Channel target are mutually exclusive; omission uses the caller Session. File preparation alone is not successful delivery, though WebUI's supported download fallback can supply the deliverable without a Channel-native file send.

Successful deliveries addressed to the current Session or its exact WebUI target appear in a reply-file grid outside process disclosure. Ordinary file writes, failures, model-authored links, and deliveries elsewhere do not qualify. Delivery IDs deduplicate replay, not filenames. The UI reconstructs from loaded receipts without adding messages or fetching all history; this is not an immutable file store, so a later missing source/cache file can make a download unavailable. See [file delivery](../units/src-file-delivery.md) and [reply-file qualification](../threads/webui-attachment-presentation.md#d-reply-file-deliveries).

### Resource-bound browser downloads

| Resource/action | Authorization boundary |
| --- | --- |
| Filesystem signature issuance / unsigned download | Administrator-only; path must be absolute and name a file. A scoped identity cannot mint arbitrary-path grants. |
| Global blob signature issuance | Administrator-only. Global blob reads accept administrator authority or a valid resource signature. |
| Session blob signature issuance / unsigned read | Administrator Session access, or scoped WebUI Session access with a committed active reference or sequence-proven effective Archive reference. A scoped caller's knowledge of a blob ID alone is insufficient. |
| Native browser download from a signed URL | A short-lived resource grant for GET/HEAD, not a new login, general API token, or right to mint further grants. |

A valid credential **or** valid resource signature authorizes the resource; a bad signature does not veto otherwise valid credentials. Signatures bind resource kind, path/blob, optional Session route, filename/preview options, and expiry. Path, global-blob, and Session-blob grants are not interchangeable. Explicit download actions request fresh 15-minute grants; normal authenticated preview URLs remain unchanged. The instance token is never placed in these URLs. Token replacement invalidates old grants; ordinary restart does not. Expiry is checked at request start, not by interrupting an accepted stream. All URLs retain deployment prefixes. Detailed authority and safe MIME/disposition/HEAD behavior remain in [download capabilities](../modules/webui.md#d-webui-download-capabilities).

## Retention and limits

Canonical blobs currently have no automatic garbage collection because retained archives can outlive live Session deletion. Deleting/clearing active history or closing a browser pane is not blob erasure. Read-old/write-new handling lazily imports valid legacy inline/path images; failed materialization retains old persisted bytes, while browser transport reports unavailable image data rather than leaking legacy paths/base64. Derived optimization-cache loss only recomputes provider input and does not delete originals. Underlying attachment files and delivery caches have their own filesystem lifetime, not the canonical blob retention guarantee. See [image lifecycle](../threads/image-blob-lifecycle.md) and [conversation/history distinctions](./conversation-and-history.md).
