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

Load externalizes history images in an owned mutable ingress document before freezing history records. The in-memory envelope excludes the separately owned `history`, `queue`, and `meta` branches; authority serialization reconstructs those fields from the snapshot and retains the existing full-document validation and durable write. Persisting authority still materializes the complete current history; immutable roots do not bypass schema validation or publication ordering.

Accepted Archive work is always resolved, including after local JSON preparation fails. Prepublication failure compensates only the exact rows inserted by that command; exact replay rows remain untouched. Compaction admits blocks/messages together before JSON preparation and awaits their committed receipt before the same atomic file write. Canonical append retains its existing non-cancellable publication behavior after admission (including completed tool effects); compaction retains its token check and pre-rename cancellation/rollback. File rename, file/directory sync and committed-failure classification are unchanged. The independent Archive and JSON authorities do not acquire cross-database atomicity.

The store is bound to one `(sessionId, agent)` lifetime. Archive writes require the exact current identity; historical aliases are read-only. Exact replay is idempotent, conflicting same-sequence payloads fail closed. A projection failure after JSON publication becomes `AuthorityCommittedException`, leaving hot state/newer JSON intact and an older catalog projection for a later retry.

## Tests

`dotnet/Foxwarm.Tests/Sessions/ArchiveWriterOverlapTests.cs` (held Archive completion versus validated/serialized preparation/publication, preparation-failure compensation, independent batching and input ownership); `PersistentSessionTurnTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionIdentityRecoveryTests.cs`; `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`.
