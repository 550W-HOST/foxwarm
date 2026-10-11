# Unit: Archive branches, blocks, and reservations

Files: `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveBlocks.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveBranches.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveReservations.cs`

## Purpose

Stores immutable compaction blocks, branch/fork caps, and committed Session-ID reservations used by Archive lineage and identity reconciliation.

## Stable methods and callers

- Branch helpers create/read/rollback one owned branch with parent identity, message cap, and block cap.
- Block helpers write/read exact block summaries and source ranges, expose effective block high-water, and roll back only newly inserted owned blocks after a failed authority precommit.
- Reservation helpers maintain SQLite identity mappings mirrored by `CommittedArchiveIdentity`; conflicting mappings and cycles fail closed.

Callers: `SessionSaveLane.CommitCompactionAsync`, `SessionManager.ForkAsync`, `ArchiveContextReader`, `CommittedArchiveIdentity`, and Archive lineage tests.

## Contract and side effects

Nested effective reads apply cumulative fork caps: late parent/child rows do not leak into a descendant after its fork point. Parent rows are never copied or deleted when a child branch is compensated. Block pruning in a compaction operation concerns active context selection; it does not rewrite immutable Archive rows or alter committed branch identity.

`ArchiveBlockRecord.FrictionScore` is nullable and part of immutable block identity, duplicate-write comparison, and compensation. Initialization adds the nullable `friction_score` column to an otherwise valid old block schema; read-only old-schema readers project a missing column as null without migrating it. Owned/effective reads preserve scores, including zero, through cumulative fork caps and restart. Context metadata and rendered summaries expose a score only when present.

## Tests

`dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`; `ArchiveFrictionTests.cs`; `PersistencePrimitiveTests.cs`; `dotnet/Foxwarm.Tests/Sessions/ForkClearLifecycleTests.cs`.
