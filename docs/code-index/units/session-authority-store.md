# Unit: Persistent Session authority store

Files: `dotnet/Foxwarm/Sessions/Turns/PersistentSessionAuthorityStore.cs`

## Purpose

Bridges an ordered `SessionSaveLane` to the two durable authorities: active Session JSON and immutable Archive SQLite. It also hydrates cold owners and publishes Main-owned catalog projections.

## Stable methods and callers

- `CommitAsync` validates a bound snapshot, writes active JSON, then calls `PublishProjection`.
- `CommitCanonicalAppendAsync` validates, admits exact Archive message rows, constructs/validates/serializes authority JSON while persistence is pending, awaits the Archive commit, then publishes active JSON, rolls back only rows inserted by a failed pre-rename attempt, and publishes the projection after JSON publication.
- `CommitCompactionAsync` performs the corresponding Archive block/message write followed by active JSON write and inserted-row rollback.
- `LoadAsync` reads only the bound Session JSON, normalizes legacy input through `SessionCatalog.NormalizeAuthority`, externalizes image parts, and throws if Archive rows exist without active authority. When both JSON and Archive are absent it returns `null`; the caller still decides whether that lifetime is creatable. `SessionManager.Admission` rejects a missing authority for an already registered catalog member instead of silently creating an empty Session.
- `RebindIdentity`, `PersistIdentitySnapshotAsync`, and `Retire` support ordered identity moves and owner shutdown; `CheckWrite` prevents writes after retirement or failed identity authority.

Callers: `SessionSaveLane`, `SessionRegistry.LoadOrAddAsync`, `SessionManager`, and the compaction/fork lifecycle. Consumers receive `SessionSnapshot` or catalog projection callbacks rather than the store mutating Session state itself.

## Contract and failure behavior

Load externalizes history images in an owned mutable ingress document before freezing history records. The in-memory envelope excludes the separately owned `history`, `queue`, and `meta` branches. At cold ingress `DetachDocument` reparses the envelope, metadata and each queue record independently before restore: `JsonNode.DeepClone` isolates mutations but parsed scalar elements can still share the original full authority `JsonDocument`. These bounded documents therefore cannot retain unrelated history backing arrays. Queue source/open fields, parts and prebuilt messages all originate from the detached queue record; unknown fields and scalar values remain serializable. Immutable history records retain their own existing ownership boundary, and ordinary snapshot/enumeration still shares the persistent root.

Authority serialization reconstructs those fields from the snapshot and retains the existing full-document validation and durable write. Persisting authority still materializes the complete current history once, then transfers the freshly built tree to `SessionAuthorityDocument` without a second full-tree clone; envelope, metadata, queue and message projections remain detached from the snapshot. Immutable roots do not bypass schema validation or publication ordering. Load validates the owned normalized tree after Main context overlay, externalizes images there and freezes the records without an intermediate authority-document copy.

Accepted Archive work is always resolved, including after local JSON preparation fails. Prepublication failure compensates only the exact rows inserted by that command; exact replay rows remain untouched. Compaction admits blocks/messages together before JSON preparation and awaits their committed receipt before the same atomic file write. Canonical append retains its existing non-cancellable publication behavior after admission (including completed tool effects); compaction retains its token check and pre-rename cancellation/rollback. File rename, file/directory sync and committed-failure classification are unchanged. The independent Archive and JSON authorities do not acquire cross-database atomicity.

The store is bound to one `(sessionId, agent)` lifetime. Archive writes require the exact current identity; historical aliases are read-only. Exact replay is idempotent, conflicting same-sequence payloads fail closed. Strict save, canonical append and compaction attempt the Main catalog projection after known JSON publication, including a post-rename durability failure, then report the committed error. This preserves catalog membership for subsequent ordinary WebUI ingress when projection succeeds; it does not guarantee projection success. The file seam covers errors opening/syncing the parent directory after rename (unsupported sync remains a nonfatal result), plus injected post-rename and post-sync faults. Pre-rename failure never publishes the projection. A projection failure after JSON publication becomes `AuthorityCommittedException`, leaving hot state/newer JSON intact and an older catalog projection for a later normal save. If both durability and projection fail, the committed exception retains both causes.

Atomic write-stage and canonical-append callbacks remain direct construction seams. The manager can forward them internally for owning-boundary tests; no filesystem fault protocol or operation-classification scopes select writes. A canonical callback runs after Archive enqueue and authority preparation, before awaiting its receipt and before active JSON publication; reaching it alone does not prove Archive commit.

## Tests

`dotnet/Foxwarm.Tests/Sessions/ArchiveWriterOverlapTests.cs` (held Archive completion versus validated/serialized preparation/publication, preparation-failure compensation, independent batching and input ownership); `SessionAuthorityRetentionTests.cs` measures deduplicated UTF-8 backing arrays reachable through loaded/restored envelope, metadata, all queue paths and immutable history, then checks caller isolation, sharing, strict save and cold reopen. `PersistentSessionTurnTests.cs`; `CommittedAuthorityProjectionTests.cs` (durable catalog consequences for strict save/append/compaction, combined failures, and real WebUI creation followed by ordinary ingress and cold reopen); `SessionCatalogPublicationTests.cs`; `SessionIdentityRecoveryTests.cs`; `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`.
