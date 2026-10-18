# Unit: Archive message store and read queries

Files: `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveMessageStore.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveQueries.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveWriter.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveVector.cs`, `dotnet/Foxwarm/Sessions/Storage/LegacyArchiveRecords.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveLegacyImport.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveLegacyImport.Sql.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveExport.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteOnlyArchivesMigration.cs`

## Purpose

Owns immutable raw Archive message rows and the bounded local/effective readers used by prompt reconstruction, history inspection, Sidebar counts, and lexical/vector preparation.

## Stable methods and callers

- `Initialize` validates the source-compatible SQLite schema and enables WAL, `synchronous=FULL`, foreign keys, and bounded busy timeout.
- `WriteMessages` validates canonical message shape, inserts exact `(session, seq)` rows transactionally, treats identical replay as a no-op, and rejects conflicting payloads.
- `RollbackInsertedMessages` removes only rows whose stored payload exactly matches the inserted set; pre-existing replay rows are never compensation targets.
- `ReadMessages`, `ReadMessagesRange`, `ReadMessageBySeq`, `ReadEffectiveMessagesRange`, and page/topology helpers serve local or lineage-bounded read paths. Effective reads apply cumulative branch caps without copying or mutating parent rows.
- `VectorCheckpoint`, `SetVectorCheckpoint`, `LocalVectorMaxima`, `VectorLineage` and local stats expose Source-compatible derived progress and cumulative scopes. Checkpoint writes retain exact Source Session keys through the same queued writer; they never redirect a historical key into audit writes. Read-only readers do not repair aliases or create storage. Checkpoints do not authorize or rebuild active history.
- Local numeric readers support bounded Vector/FTS batches and substantive message windows, applying role/visibility selection before the limit. Block ranges support bounded descending transient search.
- Query helpers preserve alias-aware, bounded, read-only behavior for counts, candidate search, list sequence maxima, and vector backfill inputs.

Callers: `PersistentSessionAuthorityStore`, `SessionCompactor`, `ArchiveContextReader`, Session list query projections, and image/context/vector preparation. Missing active JSON is handled by the authority store, not this reader.

## Side effects and compatibility

The Main data-root owner pins one Archive writer and long-lived non-pooled connection, separate from the journal. All live writes (messages, blocks, branches, reservations, identity moves and exact compensation) use that owner. Standalone adapters borrow the same process-local owner for accepted operations; their final lease drains and closes it. Separate processes retain SQLite's existing WAL/FULL and busy-timeout concurrency handling. Native `busy_timeout=5000` is installed before database-dependent setup. Schema validation/migration runs when the owner opens; an explicit initialization boundary is ordered, not a bypass around queued work. Ordinary reads use independent read-only connections and retain their existing snapshot behavior. See [batch/error/cancellation/lifecycle mechanics](./dotnet-sqlite-writers.md).

`EnqueueMessagesAsync` validates and owns appended raw values before admission, returning a separate committed inserted-row receipt. The synchronous `WriteMessages` API still waits for durability and returns only newly inserted input records. The writer checks exact current identity and immutable replay/conflict state in transaction order; one rejected command rolls back its savepoint without discarding unrelated commands. Exact compensation is also queued. Blocks and messages belonging to one compaction command share its savepoint and outer transaction.

Immutable message/block/branch writes are exact-current-identity only; historical aliases can read committed rows but cannot redirect those writes. Derived checkpoints retain the reference implementation's exact-key progress semantics and are not identity proof. The schema preserves the source-compatible `archive_messages` columns/primary key and rejects unsupported extra indexes or foreign keys. Archive rows are immutable audit/context records even when active JSON history is cleared or compacted.

## Legacy migration and JSONL export

`SqliteOnlyArchivesMigration.RunAsync` is the fixed Source `sqlite-only-large-archives-v1` owner shared by public model/archive operations and Main's bootstrap, before identity/Session recovery or Vector opening. It takes the existing per-data-root migration lock. A completed `state/migrationVersion.json` entry requires both SQLite databases and matching authority markers, without creating empty replacements. An incomplete/missing version restores interrupted moves using the existing verified backup manifest, imports Session archives, verifies/imports the journal without moving it independently, marks both databases, writes the joint manifest, moves verified physical sources and finally publishes the completed version. Independent SQLite import commits can survive failure; they are not a cross-database transaction. Already-moved timestamped backups from the earlier C# journal importer remain untouched.

`LegacyArchiveRecords` validates the actual Source migration message/block shapes independently of stricter active Session constructors. LF/CRLF framing preserves Unicode line separators. The narrow append-after-torn-string recovery requires one complete matching Session/sequence suffix; divergent recoveries fail. The original physical file is backed up unchanged. Recovery markers and manifest audit fields retain Source identities and retry semantics.

`ImportLegacyAsync` runs on the existing Archive writer. It validates all candidate logs before creating branches/aliases/imported rows; candidates come from persisted Session metadata/backups (or existing C# catalog), supported history metadata recovery and regular legacy log files. Existing identity owners merge ledger/mirror evidence and persisted aliases, reject conflicts/cycles, and preserve uncertain historical payload lifetimes rather than inventing moves. Copied fork prefixes determine branch caps/checkpoint baselines. Source import-state size/mtime checks and bounded transactions remain; preexisting SQLite rows win, while new conflicting duplicates fail full-file verification. Successful import verifies branch topology, record counts/content, file identity and database integrity before backup publication. No Session lifetime is loaded by the standalone CLI.

`ExportJsonlAsync` exports one independent SQLite read snapshot into a temporary Session tree, replaces the prior output tree, and returns nonempty file/record counts. It exports local message/block rows under exact Session IDs, not expanded inherited copies. Path escapes/filesystem-root targets fail. The journal exports its own consistent snapshot and record count. These compatibility JSONL files are readable by the real Source importers; ordinary runtime writes remain SQLite-only.

## Tests

`dotnet/Foxwarm.Tests/Storage/CliArchiveMigrationTests.cs` and `dotnet/cli-archive-fixture-ts.mjs` exercise real Source-produced legacy forks/journal, public archive stdout/files/counts, Source reimport/reconstruction, structural failure, preexisting authority, duplicate conflict/retry, interrupted joint moves, torn recovery, prior journal backups and ordinary console startup. `dotnet/Foxwarm.Tests/Storage/PersistencePrimitiveTests.cs`; `ArchiveLineageTests.cs`; `CommittedArchiveBoundaryTests.cs`; `dotnet/Foxwarm.Tests/Sessions/SessionCatalogPublicationTests.cs`.
