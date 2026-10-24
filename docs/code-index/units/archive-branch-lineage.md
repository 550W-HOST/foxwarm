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

Branch initialization validates the six named columns used by current Source lineage and accepts retained additional columns without reading or rewriting their values. Reads and writes project the current columns explicitly; a retained `fork_block_raw_end_seq` value does not add a raw-sequence block cap to current message/block-ID lineage. Required column definitions and invalid fork frontiers still fail validation.

Branch existence/replay decisions and branch/block mutations run in the shared Archive writer transaction, including exact compensation. A newly inserted fork seeds Source-compatible Vector progress from its immutable message/block caps in that transaction, independently of enabled Vector. Exact owned-branch compensation removes its checkpoint; the Main lifecycle resets derived dense/lexical state before this compensation, not after it. Committed clear/deletion retains Archive and derived sources. Block JSON strings are prepared once outside the writer; queued records own their values.

Failed creation compensation resolves its recorded parent through committed identity aliases before matching the owned branch. A successful concurrent parent move may rewrite that edge without transferring the failed child's ownership; compensation still requires the exact child ID, caps and insertion timestamps, and removes only its owned branch/checkpoint. Pending or unproven identity moves do not gain a new cleanup guarantee.

Nested effective reads apply cumulative fork caps: late parent/child rows do not leak into a descendant after its fork point. Parent rows are never copied or deleted when a child branch is compensated. Block pruning in a compaction operation concerns active context selection; it does not rewrite immutable Archive rows or alter committed branch identity.

Block reads, exact replay and compensation accept legacy block-backed ascending source ranges without `sourceBlockIds`, preserving SQL NULL and omitted context metadata. Serialized JSON null/non-array values are not SQL NULL and still fail admission on reads. This matches the [active authority read/save contract](./session-authority-json.md); current compaction still generates explicit source IDs and applies its existing stricter candidate rules.

`ArchiveBlockRecord.FrictionScore` is nullable and part of immutable block identity, duplicate-write comparison, and compensation. Initialization adds the nullable `friction_score` column to an otherwise valid old block schema; read-only old-schema readers project a missing column as null without migrating it. Owned/effective reads preserve scores, including zero, through cumulative fork caps and restart. Context metadata and rendered summaries expose a score only when present.

## Tests

The Source lifecycle fixture binds its owned `state/config.yaml` before application imports through the shared process-harness environment contract. Its Agent, skill, model and state paths stay under the supplied fixture root, and optional workers, Vector and listeners are disabled. `scripts/test/test-isolation.test.mjs` checks direct race, seed and independent-process reopen entries against synthetic caller configuration, including the legacy override.

`dotnet/Foxwarm.Tests/Storage/ArchiveSchemaCompatibilityTests.cs` and `dotnet/archive-schema-fixture-ts.mjs` cover Source open/fork/read, managed write/reopen, retained branch columns/rows, cumulative history and ordinary Source reopening. `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`; `ArchiveFrictionTests.cs`; `PersistencePrimitiveTests.cs`; `dotnet/Foxwarm.Tests/Sessions/LifecycleTransitionTests.cs` and `dotnet/lifecycle-transition-fixture-ts.mjs` (real fork failure concurrent with parent move, exact compensation and Source identity-lock control); `dotnet/Foxwarm.Tests/Sessions/ForkClearLifecycleTests.cs`; `LegacyBlockAuthorityTests.cs` and `dotnet/legacy-block-fixture-ts.mjs` (actual Source seed/reopen, mandatory owner startup, preserved legacy provenance, inherited expansion, unchanged candidate exclusion, normal compact commit and reopen).
