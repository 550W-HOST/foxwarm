# Unit: Hosted LLM journal, text-redaction cache and journal retention

Files: `dotnet/Foxwarm/Hosted/Postgres/Journal/PgLlmJournalStore.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/PgLlmJournalStore.Usage.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/PgLlmJournalStore.Redaction.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/PgLlmJournalStore.Retention.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/PgJournalWriter.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/JournalRetentionOptions.cs`, `dotnet/Foxwarm/Hosted/Postgres/TextRedaction/PgTextRedactionStore.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Journal.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0500_llm_journal.sql`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0501_text_redaction.sql`, `dotnet/Foxwarm.Tests/Models/LlmJournalContractTests.cs`, `dotnet/Foxwarm.Tests/Models/LlmJournalContractTests.Writer.cs`, `dotnet/Foxwarm.Tests/Models/LlmJournalContractTests.Usage.cs`, `dotnet/Foxwarm.Tests/Models/LlmJournalContractTests.Backends.cs`, `dotnet/Foxwarm.Tests/Models/TextRedactionStoreContractTests.Postgres.cs`, `dotnet/Foxwarm.Tests/Sessions/RequestPrefixTests.RedactionTakeover.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.Journal.cs`, `dotnet/Foxwarm.Tests/Hosted/JournalRetentionOptionsTests.cs`
Secondary files: `dotnet/Foxwarm/Models/LlmJournalReconstruction.cs`, `dotnet/Foxwarm/Models/TextRedactionRecordStore.cs`, `dotnet/Foxwarm.Tests/Models/TextRedactionStoreContractTests.cs`, `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/Models/LlmRequestJournal.cs`, `dotnet/Foxwarm/Models/TextRedactionStore.cs`

The tenant's [LLM request journal](./model-journal.md) and [text-redaction cache](./model-text-redaction-persistence.md) in PostgreSQL, behind the file stores' interfaces ([storage context](./storage-context.md#model-request-journal-and-text-redaction)), and the hosted-only journal retention.

## Journal

`PgLlmJournalStore : ILlmJournalStore` keeps the file journal's tables (`0500_llm_journal.sql`) with tenant keys. Rows hold the same values as file mode by construction:

- **Shared preparation and reconstruction.** Object encoding, hashes, the usage row, the source result and the JSON codec are the file journal's `internal` helpers. `LlmJournalReconstruction` holds the delta/checkpoint plan and the validated reconstruction over `ILlmJournalRows`; the SQLite journal uses it too, so both backends reject the same inconsistencies and assemble the same request. Its Postgres rows read a manifest chain with one recursive query.
- **Objects** are content-addressed and deduplicated per tenant: admission reads which of its object IDs exist and inserts only the missing payloads, `ON CONFLICT DO NOTHING`.
- **Order.** `seq` (identity) stands in for SQLite's `rowid`: usage checkpoints, backfill ranges and tie-breaks use it. One owner holds one journal store per tenant, so its single writer assigns `seq` in commit order.
- **Writer.** `PgJournalWriter` is the hosted counterpart of `SqliteBatchWriter`: bounded admission, up to 64 commands in one `TenantDb.Write` after a 1 ms window, a savepoint per command so a failing command fails alone and later commands still see earlier ones. A fence, a broken connection or an aborted transaction fails the whole batch. The batch records `pg_current_xact_id()`; a lost `COMMIT` reply is resolved with `pg_xact_status`.
- **Usage ledger.** Live rows are written inside the result's command under their own savepoint; a ledger failure rolls back only the row. Checkpoints (`usage-ledger-low`/`-high`) and the newest-first resumable backfill follow file mode, so the [usage overview](./usage-overview.md) reads the same data. `llm_usage` and `llm_redaction` are insert-only for the runtime role.
- **File-only.** Legacy JSONL migration, export, the SQLite authority marker and the shared per-root writer stay on `LlmRequestJournalStore`.

## Text-redaction cache

`TextRedactionRecordStore` is the backend-independent part of the cache: record identities (keyed hashes), payload formats, AES-GCM sealing and write coalescing. `TextRedactionStore` (SQLite) and `PgTextRedactionStore` (`text_redaction_meta`, `text_redaction_slots`, `text_redaction_known`, `0501_text_redaction.sql`) only read sealed records and apply coalesced batches, so they store the same bytes for the same key, and records copied between them open unchanged.

- **Key.** `InstanceSecrets` derives it with `InstanceKeys.TextRedactionStorePurpose` from its key ring; in hosted mode that is the tenant's `HostedKeyRing` ([hosted configuration](./hosted-config.md)). `HostedEntry.BuildRuntimeAsync` passes `PostgresStorageContext.OpenTextRedaction` as the opener.
- **Takeover.** A new owner derives the same key, finds the same key check and reads the previous owner's slot ranges and known values, so an unchanged slot is sent byte for byte ([D-request-prefix-stability](../overview.md)). A stored check under another key clears the records, as in file mode.
- **Cache semantics.** Reads that fail are misses, each batch is one fenced transaction, and a failed or fenced batch is dropped. Like a file-mode crash, an owner that dies loses at most its last unflushed batch; those slots are detected again. A graceful release flushes when the secrets owner is disposed.

## Journal retention

U14(c), decision C11; hosted only. File mode's journal keeps everything as before.

- **Setting.** The deployment's `journal: {retentionDays}`. Unset means unlimited, the P1 default. `JournalRetentionOptions.FromDeployment` accepts only a positive whole number and refuses anything else, naming the key; `BuildRuntimeAsync` turns that into `HostedStartupException` (exit 78) before the key ring is opened. There is no `journal.enabled` in P1 ([Open Questions](#open-questions)).
- **Job.** `BuildRuntimeAsync` starts it in the owner after the host is built. The first pass runs a minute after start, then one runs each day. It stops when the journal is disposed or on a fence; the next owner runs its own.
- **Pass.** `PurgeAsync(cutoff)` walks requests created before the cutoff in `(created_at, request_id)` batches of 500, each one writer command. It keeps a request whose delta descendants include a retained request, so every retained request stays reconstructable. It deletes the other requests' results, starts and object references, then the objects no remaining request (`llm_journal_request_objects`) or attempt (`prompt_object_id`) references.
- **Kept.** `llm_usage` and `llm_redaction` are never deleted, so the usage overview and its coverage stay complete.

## Tests

- **`LlmJournalContractTests`** (file and Postgres subclasses) holds the cases moved from `LlmUsageLedgerTests` and `JournalWriterOverlapTests`, plus delta and checkpoint reconstruction, list filters and cursor, attempt preconditions, object deduplication and the redaction queries. The file classes keep only file-only cases: ledger-table removal, the shared root writer.
- **The Postgres subclass adds:**
  - fencing for every write (admission, attempt start and result, chat result with ledger and redaction rows, redaction row, backfill, retention): `TenantFencedException` and no row changes;
  - a lost `COMMIT` resolved by transaction ID;
  - the runtime role refused `DELETE`/`UPDATE` on the ledger;
  - retention: old requests, attempts and unreferenced objects are gone, referenced objects and old chain bases stay, and the usage and redaction totals and coverage don't change;
  - the daily job deleting in the owner and stopping with the journal.
- **`TextRedactionStoreContractTests`** (file and Postgres) holds the cases moved from `TextRedactionPersistenceTests`: hand-over with byte-identical bodies and zero detector calls (a takeover at a new epoch on Postgres), invalid records, the slot LRU bound and the known-set mirror. The Postgres subclass adds fencing of every write kind and of the key-check reset, sealed contents, the foreign-key clear, file-sealed records opening unchanged and an unavailable database. The file class keeps the key-less copy and the damaged file.
- **`RequestPrefixTests+RedactionTakeover`** (`Backend=postgres`) runs a redacting Session through `SessionManager`, hands the tenant to a new owner at the next epoch and checks that the next request extends the previous one byte for byte, with only new text sent to the detector. Without the Postgres cache on the new owner it fails.
- **`HostedStartupTests.Journal`** checks the hosted runtime's journal and redaction cache and the exit-78 refusal of an invalid retention. **`JournalRetentionOptionsTests`** checks the setting's parsing.
- **Neutral classes.** `UsageHttpTests`, `UsageOverviewTests` and `RequestPrefixTests` are `Backend=neutral`; under the test backend they use the Postgres journal.

## Open Questions

- [2026-11-26] **Per-tenant journal off switch (P2).** A tenant setting that writes no journal content: admission returns an ID, attempt start and result write only the usage-ledger and redaction rows from the start data kept in memory, reconstruction reports the request as not recorded, and the list is empty. It comes with P2's per-tenant settings; P1 has only `retentionDays`.
