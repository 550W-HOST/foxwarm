# Unit: Session authority JSON and atomic file writes

Files: `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityDocument.cs`, `dotnet/Foxwarm/Sessions/Storage/LinuxAtomicJsonFile.cs`

## Purpose

Defines and durably writes the active per-Session JSON authority. `SessionAuthorityDocument` validates the supported semantic shape before any write; `LinuxAtomicJsonFile` performs temp-file write, file fsync, rename, and directory-sync classification.

## Stable symbols and callers

- `SessionAuthorityDocument.Parse`, `FromNode`, `Load`, `CloneRoot`, and `ValidateMessage` validate version, history, queue, metadata, waits, images, context-block shape, and unsupported catalog/worker fields.
- `ValidateMessageContent` shares role/parts content checks with historical Archive readers, without active metadata admission. `ValidateMessage` still requires and validates active message metadata, sequence and timestamp.
- `LinuxAtomicJsonFile.Write` and `WritePayload` are the only atomic-file publication primitives used by the authority store. `AtomicJsonWriteStage` is the testable boundary for pre-rename versus post-rename failure classification.
- `AuthorityCommittedException.AuthorityCommitted` tells callers that the rename happened even if directory sync or a later projection step failed.

Callers: `PersistentSessionAuthorityStore` builds the authority envelope; `SessionSaveLane` supplies ordered snapshots; startup loads through the store. Catalog-only `lastChannel`, `archived`, `pinned`, and sidebar fields are removed or kept outside this authority.

## Behavior and side effects

- Mutable `FromNode` input is copied before validation; `Parse` transfers its freshly parsed tree through internal `FromOwned`. The same internal transfer is used for the store's freshly built authority. Transfer callers relinquish all mutable aliases; `CloneRoot` always returns a detached tree. Validation-only normalization uses `Validate` without constructing or copying a document.
- The active `history` array and queue are validated as JSON-owned state; `meta.messageCount` must equal history length.
- Malformed `childHandoffState`, unsupported worker mailbox/frontier state, and catalog-only semantic fields fail closed instead of being silently migrated into active history.
- A failure before rename leaves the previous authority and removes the temp file. A failure after rename raises `AuthorityCommittedException`; reading the file returns the newly published document.
- Directory sync may be unsupported on a platform, but the result is recorded; the host still distinguishes publication from durability-finalization failure.
- The optional `privateFile` creation mode supplies owner-only temporary files for MCP configuration and OAuth credentials. The same write/fsync/rename/directory-sync primitive remains canonical; ordinary Session authority callers keep their existing defaults.

## Tests

`dotnet/Foxwarm.Tests/Storage/PersistencePrimitiveTests.cs`; `dotnet/Foxwarm.Tests/Memory/MessageJsonTests.cs`; `dotnet/Foxwarm.Tests/Sessions/PersistentSessionTurnTests.cs`.
