# Unit: Shared file-delivery receipt

Files: packages/shared/src/fileDelivery.ts
Secondary files: packages/shared/src/index.ts, src/toolsSessionAgent/helpers.ts, src/fileDeliveryService.ts, packages/webui/src/components/replyFiles.ts

## Purpose

Defines the small versioned delivery receipt shared by Main, trusted Session workers, and WebUI reply-file projection. Its end-to-end contract is [D-reply-file-deliveries](../threads/webui-attachment-presentation.md#d-reply-file-deliveries).

## Public symbols and function index

- `FileDeliveryArtifact` — version-1 receipt with a delivery ID, exact session/channel target, original name/MIME/byte size, source Node, and Main-owned physical download path. No bytes, arbitrary URLs, or channel-result arrays.
- `parseFileDeliveryArtifact(value)` — returns a closed clone after version, string-length, basename, absolute-path, storage-Node, and nonnegative safe-integer size checks; malformed values are not promoted into file cards.

## Integration and tests

Main emits receipts only on successful returns. The fixed file-delivery response preserves them after validation; optional absence remains read-old compatible. The UI filters target and error ownership separately and never treats a receipt as an access capability. Existing download authentication still governs each request. Pure reply-file tests and Main file-delivery service tests exercise invalid values and remote-cache provenance.
