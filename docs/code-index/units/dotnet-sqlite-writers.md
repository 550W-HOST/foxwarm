# Unit: shared SQLite writer mechanics

Files: `dotnet/Foxwarm/Persistence/SqliteBatchWriter.cs`

## Purpose and scope

Provides the small common queue/transaction mechanism for the independent .NET LLM journal and Archive writers. It is not a durable queue, outbox, cross-process broker, recovery/replay service, or shared transaction across databases. Catalog and Task storage do not use it.

## Stable symbols and callers

- `SqliteBatchWriter.EnqueueAsync` returns after bounded admission with a separate `WriteReceipt<T>.Completion`. The completion represents the outer commit, not SQL execution or savepoint release.
- `ExclusiveAsync` inserts an ordered maintenance boundary after prior batches commit and before later commands execute. Initialization and journal migration use it; ordinary exports and history reads do not hold the writer.
- `SqliteWriterOwners.Acquire` leases the process-local owner for an exact full database path. Main pins one lease for each database; journal stores also pin their owner. Archive operations retain a borrowed lease until their accepted receipt resolves. The final release stops admission, drains accepted work and closes the connection before a successor can open.
- `SqliteArchiveMessageStore.EnqueueWriteAsync`, `AcquireWriter`, and `OrderedMaintenance` are the Archive adapter boundary. The journal uses the same mechanics with its own connection/schema opener.

## Scheduling, failure, and cancellation

The bounded channel admits up to 256 waiting commands. One execution loop exclusively owns one non-pooled connection. After the first available ordinary command, a one-millisecond coalescing window collects up to 64 commands; it never waits for a full batch. These are implementation bounds, not persisted format or product limits. Pure encoding/hashing/validation remains with the producer, without encoding again for queue accounting.

Commands execute FIFO in one immediate SQLite transaction, each under a savepoint. A rejected command rolls back its own partial work; valid independent commands may still commit. Database-dependent decisions see earlier successful commands in the same batch. A savepoint recovery or outer-commit failure fails every member without successful acknowledgment. A failed connection opener fails the first accepted command and all remaining accepted work, closes admission, and does not replay commands. All receipt continuations run asynchronously, not inline on the writer.

Cancellation can reject admission or skip a queued command before execution. Once execution begins, that caller's token does not abort its transaction, cancel another member, or replace the actual commit result with waiter cancellation. Callers retain their own semantics: canonical append finishes accepted completed tool effects, while compaction can cancel publication and perform exact inserted-row compensation. Normal reads use independent connections; dependencies await their write receipt before reading or publishing.

`BeforeBatch`, `BeforeCommit` and bounded commit counters are internal test seams, not runtime APIs or persisted diagnostics. Maintenance callbacks are internal database operations, not arbitrary Session continuations; they must not enqueue-and-await their own writer.

## Design decision: D-dotnet-persistence-overlap-and-batching

[2026-10-16] Use separate shared journal and Archive writers for the Main data-root owner. Admit prepared work before genuinely independent preparation, then await durability at the latest required provider-send or authority-publication boundary. Merge available commands into bounded transactions now, isolating ordinary command failures, while preserving WAL/FULL, immutable content/identity checks, exact compensation and committed JSON failure classification. Queue admission is not durability, and successful responses are not fire-and-forget. No new persisted schema or cross-database atomicity is introduced.

The concrete caller map belongs to [the journal](./model-journal.md) and [the authority store](./session-authority-store.md); Archive identity and lineage contracts remain with their owning units.

## Tests

`dotnet/Foxwarm.Tests/Storage/SqliteBatchWriterTests.cs`; `dotnet/Foxwarm.Tests/Models/JournalWriterOverlapTests.cs`; `dotnet/Foxwarm.Tests/Sessions/ArchiveWriterOverlapTests.cs`. Existing journal reconstruction/content-identity/pre-send/no-resend and Archive/save-lane/Stop/compaction/fork/move/deletion tests remain the behavioral regression surface.
