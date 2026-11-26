# Unit: Hosted Archive and identity ledger

Files: `dotnet/Foxwarm/Hosted/Schema/Migrations/0300_archive.sql`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0301_archive_direct_effects.sql`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0302_identity_pending_move.sql`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveRows.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveRows.Identity.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveReads.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveSession.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveStore.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveStore.DirectEffects.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgIdentityLedger.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/ArchiveSequenceProjection.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Archive.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Identities.cs`, `dotnet/Foxwarm/Sessions/Storage/ArchiveRowAdmission.cs`
Tests: `dotnet/Foxwarm.Tests/Hosted/PgArchiveRowsTests.cs`, `dotnet/Foxwarm.Tests/Hosted/ArchiveSequenceProjectionTests.cs`, `dotnet/Foxwarm.Tests/Hosted/ArchiveGoldenComparisonTests.cs`, `dotnet/Foxwarm.Tests/Storage/ArchiveStoreContractTests.cs`, `dotnet/Foxwarm.Tests/Storage/IdentityLedgerContractTests.cs`, `dotnet/Foxwarm.Tests/Sessions/IdentityTestStorage.cs`

## Purpose

PostgreSQL implementation of the [Archive](./storage-context.md#archive) and the [identity ledger](./storage-context.md#identity-ledger) for a hosted tenant. Rows, lineage and identity semantics are those of the file implementation ([message store](./archive-message-store.md), [branches and blocks](./archive-branch-lineage.md), [identity moves](./archive-identity-and-moves.md)); this unit records only what the database representation changes. Every write goes through `TenantDb` and its [write fence](./hosted-database.md#d-hosted-write-fence).

## Contracts

### D-hosted-archive-tables

**Derived from the approved P1 plan (§5, 2026-11-26).** Migration 0300 creates `archive_messages`, `archive_blocks`, `archive_branches` and `session_id_reservations`, all tenant tables.

- **Columns** follow the SQLite tables. Sequence numbers, IDs and millisecond times are `bigint`, row timestamps `double precision` (SQLite stores whole and fractional values in the same column), and every text column is `COLLATE "C"`.
- **Extracted columns.** `archive_messages` carries two values computed from `message_json` at insert, replacing the JSON functions the SQLite readers run: `model_visible` (the `modelVisible` flag, for substantive windows) and `sequence_data` ([D-hosted-archive-sequence-projection](#d-hosted-archive-sequence-projection)).
- **Grants.** The runtime role has `SELECT`, `INSERT` and `DELETE` (the exact rollback of rows an attempt inserted). `UPDATE` is granted only on the identity columns that an identity rename rewrites: `session_id` of messages and blocks, and `session_id`, `parent_session_id` and `updated_at` of branches. Reservations are insert-only.
- **One reservation table.** `session_id_reservations` is the single authority for committed identity mappings. File mode keeps a JSONL ledger with a SQLite mirror; here there is nothing to mirror, so the mismatch recovery case doesn't exist.
- **Not stored:** Vector checkpoints (`archive_checkpoints`), the derived activity index (`archive_tool_effects` and its metadata), the legacy import state, and the branch column `fork_block_raw_end_seq`, which older installations carry but no reader uses. Vector and the activity index are off in hosted P1 and are rebuilt from Archive rows when they arrive (P3).

### D-hosted-archive-row-insert

**Approved P1 plan §4.2 (2026-11-26).** `PgArchiveRows.Insert`/`InsertAsync` write one Session's rows inside a caller's `TenantDb` transaction; the Session authority commit uses it so that Archive rows and the authority head commit together.

- **Preparation.** `PgArchiveBatch.Prepare` applies the same current-write admission as the file store (`ArchiveRowAdmission`, shared code) outside the transaction, and serializes the extracted columns. `PgArchiveBatch.Import` applies the historical read rules instead and keeps the rows' recorded Session IDs, for copying an existing Archive.
- **Identity.** A prepared batch requires its Session ID to be its own current identity in the reservation graph; a historical alias throws `InvalidOperationException`, as in file mode.
- **Insert.** Blocks, then messages, each as one `INSERT … SELECT FROM unnest(…) ON CONFLICT DO NOTHING RETURNING` key. Every input key not returned (an earlier row, or a repeated key in the same batch) is compared with the stored row on all columns:
  - an exact replay is a no-op and isn't in the result;
  - any difference throws `InvalidDataException` with the file store's message, which fails the caller's transaction, so nothing of it commits.
- **Result.** `PgArchiveInserted` holds the newly inserted rows in input order, as admitted (the file store's receipt returns the same).
- **Unknown commit outcome.** `PgArchiveRows.Stored` checks that every inserted row is stored exactly; callers use it in their `Verify`.
- **Exact deletion.** `DeleteMessagesAsync` and `DeleteBlocksAsync` remove rows only when stored exactly as given; any other row throws (`InvalidDataException` for messages, `IOException` for blocks, as in file mode) and the caller's transaction removes nothing.

### D-hosted-archive-sequence-projection

**Derived.** The SQLite sequence reader extracts a small object per row inside SQLite, so tool outputs and large arguments never leave the database. In PostgreSQL that object is computed once in C# at insert (`ArchiveSequenceProjection`) and stored as `sequence_data`.

- It reproduces SQLite's conversions: a boolean read as a scalar is 1 or 0; a number read as a scalar is its double value; objects and arrays are copied unchanged; a list over a missing path is empty, over a present non-container value one entry; text is cut by code points.
- **One difference.** Where SQLite fails the whole read because a delivery or subcall list contains a bare string, the projection gives that entry null fields.
- **Maintenance rule.** A change to the SQLite sequence `Select` needs the same change here, and stored rows keep the projection they were inserted with. `ArchiveSequenceProjectionTests` compares both over rows covering every extracted field.

### D-hosted-archive-store

**Approved P1 plan §5 (2026-11-26).** `PgArchiveStore` is the tenant's `IArchiveStore`; `PgArchiveSession` its `IArchiveSession`. Semantics are the file store's; the differences are representation only.

- **Writer.** `AcquireWriter` holds nothing: the tenant lease makes this replica the only writer, and every write carries the lease epoch.
- **Writes.** Each `IArchiveSession` write (`WriteMessages`, `WriteBlocks`, the `Enqueue…` receipts, `EnsureBranch`) is one fenced transaction through `PgArchiveRows`, with a `Verify` for a lost commit. A receipt's completion is that transaction's commit.
- **Rollback.** `RollbackInserted*` deletes exactly the given rows in their own fenced transaction ([exact deletion](#d-hosted-archive-row-insert)); `RollbackInsertedBranch` deletes only the identical branch row, resolving its parent edge through committed moves as file mode does. The authority commit doesn't use them: its rows commit or roll back with its own transaction.
- **Reads.** Every read is one read transaction; effective (lineage) reads take a snapshot, so all lineage parts come from one state. Reads of an unknown identity create nothing.
- **"No Archive yet" doesn't exist here.** Where the file store returns null because no SQLite file exists (identity and sequence readers, `ResolveCommittedIdentity`), this store answers from empty tables: readers are always returned and an unreserved ID resolves to itself.
- **Sequence reader.** The span cache, cursor decision and window search are the file reader's shared code (`SqliteArchiveSequence.CachedSpan`, `SeqBefore`, `WindowStart`) over PostgreSQL probes; rows come from `sequence_data`. The span cache lives in the store instance, one per tenant context.
- **Rename.** `RenameIdentity` rewrites the identity columns of messages, blocks, branches (own and parent edges) and direct effect records in one fenced transaction. Reservations aren't rewritten; they are identity authority.

### D-hosted-archive-direct-effects

**User decision (2026-11-26): hosted P1 stores the Activity direct effect records; import migrates them; the derived index and System › Activity stay in P3.** Migration 0301 creates `archive_direct_effects` with the file table's columns and an identity `id` for insertion order. `RecordDirectEffectAsync` appends one row in a fenced transaction; the runtime role has `SELECT`, `INSERT` and `UPDATE (session_id)` for renames, so records are never deleted. `ReadDirectEffects` reads them in insertion order for import checks and tests.

### D-hosted-identity-ledger

**Approved P1 plan §5; decision C2 (no cross-store unit of work).** `PgIdentityLedger` keeps committed mappings only in `session_id_reservations`, the table the Archive resolves through, so the file ledger's JSONL rewrite, SQLite mirror and their mismatch recovery don't exist.

- **Same rules.** Graph validation, rename validation and the catalog alias merge are the file ledger's static helpers; `InitializeAsync` inserts only aliases the catalog proves and that aren't committed yet.
- **Pending move.** Migration 0302 holds at most one `session_identity_pending_move` row per tenant with the intent's JSON; it is read through `SessionIdentityMoveJournal.Parse`, so a stored intent is validated exactly as in file mode. The protocol is unchanged: each step (intent, authority move, Archive rename, reservation commit, clear) is its own transaction, and startup recovery replays the intent.
- **Artifacts.** A hosted tenant has no per-Session files besides the authority (file mode also moves legacy logs and frontier files), so `MoveArtifacts` moves the authority only.
- **Startup evidence.** Only the pending intent is checked; the file ledger's SQLite-only migration evidence has no hosted counterpart.

## Tests

- `PgArchiveRowsTests` (`Backend=postgres`): returned sets and exact replays, a conflicting message or block failing the caller's whole transaction including its own statement, admission before any transaction, alias and cycle refusal, exact deletion, the async path, a fenced insert leaving nothing, and the column-level `UPDATE` grants.
- `ArchiveSequenceProjectionTests`: the stored projection equals the SQLite reader's output.
- `ArchiveStoreContractTests` (file and Postgres subclasses): rows, receipts, admission, concurrent callers, lineage caps and context expansion, branch compensation, block range and time reads, substantive windows, friction scores, opaque metadata, committed aliases, read purity, sequence counts and paging, direct effect records. The Postgres subclass adds a fencing case for every write. SQLite schema, migration and import cases stay in the file-mode classes.
- `IdentityLedgerContractTests` (file and Postgres): renames visible to the Archive and to a reopened ledger, rename validation, the pending move and its startup refusal; fencing cases for every ledger write.
- `ArchiveGoldenComparisonTests` (opt-in, `FOXWARM_GOLDEN_ARCHIVE`): imports a real Archive copy and compares every reader's output on both stores, printing only reader names and counts.
- Identity move, recovery, boundary and interleaving cases that set up state through the manager or the storage context carry `Backend=neutral` (`IdentityTestStorage` reads and seeds through `IStorageContext`). Cases that seed the file catalog or file authority directly, or test legacy file migration, stay file-only. In the mixed test context they run on file stores until the hosted Authority exists ([test backend](./hosted-runtime.md)).
