# Unit: Archive identity reservations and Session identity moves

Files: `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.Evidence.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.Move.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.LegacyImport.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionIdentityMoveJournal.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveIdentityMove.cs`

## Purpose

Reconciles committed historical Session IDs, Archive aliases, and startup identity-move evidence without allowing an unproven move to rewrite authority.

## Stable methods and callers

- `CommittedArchiveIdentity.InitializeAsync` validates migration evidence, reads the JSONL reservation ledger and SQLite mirror, imports only proven catalog aliases, validates the mapping graph, and mirrors committed mappings.
- `ReadLegacyMappings`/`AddLegacyMapping` reuse the ledger/graph owner for the fixed [legacy Archive importer](./archive-message-store.md#legacy-migration-and-jsonl-export), without starting a Session engine or inferring a move from copied log payloads.
- `ValidateRename` and `CommitRenameAsync` reserve an old-to-new identity only after graph validation. Ledger rename and directory-sync failures are classified as committed or rolled back according to whether the rename happened.
- `Resolve`/`ResolveReadOnly` follow committed alias chains and reject cycles; ordinary readers do not repair identity state.
- `SessionIdentityMoveJournal` records staged artifact ownership and phases; `SqliteArchiveIdentityMove` renames existing SQLite rows for a proven move/recovery direction.

Callers: `SessionManager.IdentityMove`, startup bootstrap, `SqliteArchiveMessageStore` identity checks, and deletion/recovery operations. A move operation holds the manager's identity gate and save-lane ordering before replacing the owner/store binding.

## Failure behavior and compatibility

Reservation mirror inserts/removals and proven SQLite identity renames join the same Archive queue as ordinary writes and compensation. Their receipts wait for outer commit; manager identity claims and save-lane ordering remain the lifecycle authority. Startup evidence validation still precedes writer-driven schema initialization or identity repair.

Completed SQLite-only migration evidence must have matching database authority markers. Missing databases, wrong markers, pending unsupported moves, ledger/SQLite conflicts, cycles, foreign ownership, and ambiguous catalog proof fail before fresh catalog/Main publication. Historical aliases remain read-only; writes bind to the exact current canonical identity.

## Platform durability

Ledger writes retain flush-to-disk, atomic replacement and the committed-failure callback boundary on Windows as well as Linux. Unix private modes are applied only where supported; the existing `LinuxDirectorySync` reports `Unsupported` on non-Linux systems. Normal desktop shutdown/restart persistence does not establish Windows power-loss durability or add a new recovery mechanism.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionIdentityRecoveryTests.cs`; `SessionIdentityMoveTests.cs`; `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`; `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`.
