# Unit: Hosted Archive and identity ledger

Files: `dotnet/Foxwarm/Hosted/Schema/Migrations/0300_archive.sql`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveRows.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/PgArchiveRows.Identity.cs`, `dotnet/Foxwarm/Hosted/Postgres/Archive/ArchiveSequenceProjection.cs`, `dotnet/Foxwarm/Sessions/Storage/ArchiveRowAdmission.cs`, `dotnet/Foxwarm.Tests/Hosted/PgArchiveRowsTests.cs`, `dotnet/Foxwarm.Tests/Hosted/ArchiveSequenceProjectionTests.cs`

## Purpose

PostgreSQL implementation of the [Archive](./storage-context.md#archive) and the [identity ledger](./storage-context.md#identity-ledger) for a hosted tenant. Rows, lineage and identity semantics are those of the file implementation ([message store](./archive-message-store.md), [branches and blocks](./archive-branch-lineage.md), [identity moves](./archive-identity-and-moves.md)); this unit records only what the database representation changes. Every write goes through `TenantDb` and its [write fence](./hosted-database.md#d-hosted-write-fence).

## Contracts

### D-hosted-archive-tables

**Derived from the approved P1 plan (§5, 2026-11-26).** Migration 0300 creates `archive_messages`, `archive_blocks`, `archive_branches` and `session_id_reservations`, all tenant tables.

- **Columns** follow the SQLite tables. Sequence numbers, IDs and millisecond times are `bigint`, row timestamps `double precision` (SQLite stores whole and fractional values in the same column), and every text column is `COLLATE "C"`.
- **Extracted columns.** `archive_messages` carries two values computed from `message_json` at insert, replacing the JSON functions the SQLite readers run: `model_visible` (the `modelVisible` flag, for substantive windows) and `sequence_data` ([D-hosted-archive-sequence-projection](#d-hosted-archive-sequence-projection)).
- **Grants.** The runtime role has `SELECT`, `INSERT` and `DELETE` (the exact rollback of rows an attempt inserted). `UPDATE` is granted only on the identity columns that an identity rename rewrites: `session_id` of messages and blocks, and `session_id`, `parent_session_id` and `updated_at` of branches. Reservations are insert-only.
- **One reservation table.** `session_id_reservations` is the single authority for committed identity mappings. File mode keeps a JSONL ledger with a SQLite mirror; here there is nothing to mirror, so the mismatch recovery case doesn't exist.
- **Not stored:** Vector checkpoints (`archive_checkpoints`), the derived activity index and the legacy import state. Vector and the activity index are off in hosted P1 and are rebuilt from Archive rows when they arrive (P3).

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

## Tests

- `PgArchiveRowsTests` (`Backend=postgres`): returned sets and exact replays, a conflicting message or block failing the caller's whole transaction including its own statement, admission before any transaction, alias and cycle refusal, exact deletion, the async path, a fenced insert leaving nothing, and the column-level `UPDATE` grants.
- `ArchiveSequenceProjectionTests`: the stored projection equals the SQLite reader's output.
