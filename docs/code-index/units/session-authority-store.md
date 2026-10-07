# Unit: Persistent Session authority store

Files: `dotnet/Foxwarm/Sessions/Turns/PersistentSessionAuthorityStore.cs`

## Purpose

Bridges an ordered `SessionSaveLane` to the two durable authorities: active Session JSON and immutable Archive SQLite. It also hydrates cold owners and publishes Main-owned catalog projections.

## Stable methods and callers

- `CommitAsync` validates a bound snapshot, writes active JSON, then calls `PublishProjection`.
- `CommitCanonicalAppendAsync` validates, writes exact Archive message rows, writes active JSON, rolls back only rows inserted by a failed pre-rename attempt, and publishes the projection after JSON publication.
- `CommitCompactionAsync` performs the corresponding Archive block/message write followed by active JSON write and inserted-row rollback.
- `LoadAsync` reads only the bound Session JSON, normalizes legacy input through `SessionCatalog.NormalizeAuthority`, externalizes image parts, and throws if Archive rows exist without active authority. When both JSON and Archive are absent it returns `null`; the caller still decides whether that lifetime is creatable. `SessionManager.Admission` rejects a missing authority for an already registered catalog member instead of silently creating an empty Session.
- `RebindIdentity`, `PersistIdentitySnapshotAsync`, and `Retire` support ordered identity moves and owner shutdown; `CheckWrite` prevents writes after retirement or failed identity authority.

Callers: `SessionSaveLane`, `SessionRegistry.LoadOrAddAsync`, `SessionManager`, and the compaction/fork lifecycle. Consumers receive `SessionSnapshot` or catalog projection callbacks rather than the store mutating Session state itself.

## Contract and failure behavior

The store is bound to one `(sessionId, agent)` lifetime. Archive writes require the exact current identity; historical aliases are read-only. Exact replay is idempotent, conflicting same-sequence payloads fail closed. A projection failure after JSON publication becomes `AuthorityCommittedException`, leaving hot state/newer JSON intact and an older catalog projection for a later retry.

## Tests

`dotnet/Foxwarm.Tests/Sessions/PersistentSessionTurnTests.cs`; `SessionCatalogPublicationTests.cs`; `SessionIdentityRecoveryTests.cs`; `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`.
