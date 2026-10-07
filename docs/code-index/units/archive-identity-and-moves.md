# Unit: Archive identity reservations and Session identity moves

Files: `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.Evidence.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.Move.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionIdentityMoveJournal.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveIdentityMove.cs`

## Purpose

Reconciles committed historical Session IDs, Archive aliases, and startup identity-move evidence without allowing an unproven move to rewrite authority.

## Stable methods and callers

- `CommittedArchiveIdentity.InitializeAsync` validates migration evidence, reads the JSONL reservation ledger and SQLite mirror, imports only proven catalog aliases, validates the mapping graph, and mirrors committed mappings.
- `ValidateRename` and `CommitRenameAsync` reserve an old-to-new identity only after graph validation. Ledger rename and directory-sync failures are classified as committed or rolled back according to whether the rename happened.
- `Resolve`/`ResolveReadOnly` follow committed alias chains and reject cycles; ordinary readers do not repair identity state.
- `SessionIdentityMoveJournal` records staged artifact ownership and phases; `SqliteArchiveIdentityMove` renames existing SQLite rows for a proven move/recovery direction.

Callers: `SessionManager.IdentityMove`, startup bootstrap, `SqliteArchiveMessageStore` identity checks, and deletion/recovery operations. A move operation holds the manager's identity gate and save-lane ordering before replacing the owner/store binding.

## Failure behavior and compatibility

Completed SQLite-only migration evidence must have matching database authority markers. Missing databases, wrong markers, pending unsupported moves, ledger/SQLite conflicts, cycles, foreign ownership, and ambiguous catalog proof fail before fresh catalog/Main publication. Historical aliases remain read-only; writes bind to the exact current canonical identity.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionIdentityRecoveryTests.cs`; `SessionIdentityMoveTests.cs`; `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`; `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`.
