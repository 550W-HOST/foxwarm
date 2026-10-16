# Unit: Archive message store and read queries

Files: `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveMessageStore.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveQueries.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveWriter.cs`

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

The Main data-root owner pins one Archive writer and long-lived non-pooled connection, separate from the journal. All live writes (messages, blocks, branches, reservations, identity moves and exact compensation) use that owner. Standalone adapters borrow the same process-local owner for accepted operations; their final lease drains and closes it. Separate processes retain SQLite's existing WAL/FULL and busy-timeout concurrency handling. Native `busy_timeout=5000` is installed before database-dependent setup. Schema validation/migration runs when the owner opens; an explicit initialization boundary is ordered, not a bypass around queued work. Ordinary reads use independent read-only connections and retain their existing snapshot behavior. See [batch/error/cancellation/lifecycle mechanics](./dotnet-sqlite-writers.md).

`EnqueueMessagesAsync` validates and owns appended raw values before admission, returning a separate committed inserted-row receipt. The synchronous `WriteMessages` API still waits for durability and returns only newly inserted input records. The writer checks exact current identity and immutable replay/conflict state in transaction order; one rejected command rolls back its savepoint without discarding unrelated commands. Exact compensation is also queued. Blocks and messages belonging to one compaction command share its savepoint and outer transaction.

Writes are exact-current-identity only; historical aliases can read committed rows but cannot redirect writes. The schema preserves the source-compatible `archive_messages` columns/primary key and rejects unsupported extra indexes or foreign keys. Archive rows are immutable audit/context records even when active JSON history is cleared or compacted.

## Tests

`dotnet/Foxwarm.Tests/Storage/PersistencePrimitiveTests.cs`; `ArchiveLineageTests.cs`; `CommittedArchiveBoundaryTests.cs`; `dotnet/Foxwarm.Tests/Sessions/SessionCatalogPublicationTests.cs`.
