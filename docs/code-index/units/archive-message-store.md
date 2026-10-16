# Unit: Archive message store and read queries

Files: `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveMessageStore.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveQueries.cs`

## Purpose

Owns immutable raw Archive message rows and the bounded local/effective readers used by prompt reconstruction, history inspection, Sidebar counts, and lexical/vector preparation.

## Stable methods and callers

- `Initialize` validates the source-compatible SQLite schema and enables WAL, `synchronous=FULL`, foreign keys, and bounded busy timeout.
- `WriteMessages` validates canonical message shape, inserts exact `(session, seq)` rows transactionally, treats identical replay as a no-op, and rejects conflicting payloads.
- `RollbackInsertedMessages` removes only rows whose stored payload exactly matches the inserted set; pre-existing replay rows are never compensation targets.
- `ReadMessages`, `ReadMessagesRange`, `ReadMessageBySeq`, `ReadEffectiveMessagesRange`, and page/topology helpers serve local or lineage-bounded read paths. Effective reads apply cumulative branch caps without copying or mutating parent rows.
- Query helpers preserve alias-aware, bounded, read-only behavior for counts, candidate search, list sequence maxima, and vector backfill inputs.

Callers: `PersistentSessionAuthorityStore`, `SessionCompactor`, `ArchiveContextReader`, Session list query projections, and image/context/vector preparation. Missing active JSON is handled by the authority store, not this reader.

## Side effects and compatibility

Each write retains its own non-pooled connection; concurrent Sessions do not share a connection or transaction. Schema initialization and `OpenConfigured` install the existing native `busy_timeout=5000` before database-dependent PRAGMAs, including `synchronous=FULL`. This covers first-statement preparation with the same busy handler already used by later transaction work, without changing the driver's command timeout/retry policy. FULL is still set on every configured writer before identity checks or transaction admission. Read-only connection behavior is unchanged.

Writes are exact-current-identity only; historical aliases can read committed rows but cannot redirect writes. The schema preserves the source-compatible `archive_messages` columns/primary key and rejects unsupported extra indexes or foreign keys. Archive rows are immutable audit/context records even when active JSON history is cleared or compacted.

## Tests

`dotnet/Foxwarm.Tests/Storage/PersistencePrimitiveTests.cs`; `ArchiveLineageTests.cs`; `CommittedArchiveBoundaryTests.cs`; `dotnet/Foxwarm.Tests/Sessions/SessionCatalogPublicationTests.cs`.
