# Unit: Archive identity reservations and Session identity moves

Files: `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.Evidence.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.Move.cs`, `dotnet/Foxwarm/Sessions/Storage/CommittedArchiveIdentity.LegacyImport.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionIdentityMoveJournal.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveIdentityMove.cs`

## Purpose

Reconciles committed historical Session IDs, Archive aliases, and startup identity-move evidence without allowing an unproven move to rewrite authority.

## Stable methods and callers

- `CommittedArchiveIdentity.InitializeAsync` validates migration evidence, reads the JSONL reservation ledger and SQLite mirror, imports catalog aliases only when exact-first resolution uniquely selects their owner, validates the mapping graph, and mirrors committed mappings.
- `ReadLegacyMappings`/`AddLegacyMapping` reuse the ledger/graph owner for the fixed [legacy Archive importer](./archive-message-store.md#legacy-migration-and-jsonl-export), without starting a Session engine or inferring a move from copied log payloads. Pre-catalog Source metadata aliases retain their legacy bootstrap behavior. Physical legacy files can read exact catalog parent metadata without importing presentation aliases or enumerating unrelated catalog identities; accepted catalog aliases are reconciled by `InitializeAsync` after pending directional recovery.
- `ValidateRename` and `CommitRenameAsync` reserve an old-to-new identity only after graph validation. Ledger rename and directory-sync failures are classified as committed or rolled back according to whether the rename happened.
- `Resolve`/`ResolveReadOnly` follow committed alias chains and reject cycles; ordinary readers do not repair identity state.
- `SessionIdentityMoveJournal` records staged artifact ownership and phases. Optional preparation/publication evidence and the previous single Agent metadata row extend the existing intent without changing its recovery direction. Old intents remain readable; absent prior metadata differs from an empty object. New operations write an intent-bound `.identity-owner` marker inside their prepared directory, using the existing unique preparation leaf as the proof value; rename carries that proof into the final directory. Recursive compensation validates the real directory and its matching regular marker before deletion. Missing preparation or a nullable publication flag supplies no ownership evidence. Any unverified final entry or preparation entry, including dangling links and files, preserves the intent for manual intervention with its path. Metadata compensation restores only the prior row against the current catalog. After identity commit, normal proof-file removal is idempotent and never authorizes directory deletion. A target catalog row can already be published while the journal still directs rollback; catalog aliases are not a committed rename at that boundary. Startup recovery owns the direction before catalog alias reconciliation; `SqliteArchiveIdentityMove` renames existing SQLite rows for a proven move/recovery direction.

Callers: `SessionManager.IdentityMove`, startup bootstrap, `SqliteArchiveMessageStore` identity checks, and deletion/recovery operations. A move operation holds the manager's identity gate and save-lane ordering before replacing the owner/store binding.

## Failure behavior and compatibility

Reservation mirror inserts/removals and proven SQLite identity renames join the same Archive queue as ordinary writes and compensation. Their receipts wait for outer commit; manager identity claims and save-lane ordering remain the lifecycle authority. Startup evidence validation still precedes writer-driven schema initialization or identity repair.

Completed SQLite-only migration evidence must have matching database authority markers. Missing databases, wrong markers, pending unsupported moves, ledger/SQLite conflicts, cycles, foreign ownership, and ambiguous catalog proof fail before fresh catalog/Main publication. Historical aliases remain read-only; writes bind to the exact current canonical identity.

**Review-selected safety correction, subject to later user revision.** Read compatibility for old pending intents does not imply automatic rollback-directory cleanup compatibility. A legacy intent whose remaining directory has no verifiable proof is preserved with a manual-intervention error, before recovery changes source authority. Recovery does not manufacture a marker or introduce a legacy deletion bypass. Existing startup fencing remains; no degraded-startup or new recovery platform is added.

## Platform durability

Ledger writes retain flush-to-disk, atomic replacement and the committed-failure callback boundary on Windows as well as Linux. Unix private modes are applied only where supported; the existing `LinuxDirectorySync` reports `Unsupported` on non-Linux systems. Normal desktop shutdown/restart persistence does not establish Windows power-loss durability or add a new recovery mechanism.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionIdentityRecoveryTests.cs`; `SessionIdentityMoveTests.cs`; `dotnet/Foxwarm.Tests/Sessions/CommittedArchiveBoundaryTests.cs`; `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`.

The committed mapping reader/graph validation is also used by [upgrade inspection](./session-upgrade-inspection.md). Its inspection call performs no ledger rewrite or SQLite mirror; ordinary startup retains those publication steps.
