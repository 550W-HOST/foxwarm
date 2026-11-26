# Unit: Hosted Session authority

Files: `dotnet/Foxwarm/Hosted/Schema/Migrations/0100_session_authority.sql`, `dotnet/Foxwarm/Hosted/Postgres/Authority/PostgresSessionAuthorityBackend.cs`, `dotnet/Foxwarm/Hosted/Postgres/Authority/PostgresSessionAuthority.cs`, `dotnet/Foxwarm/Hosted/Postgres/Authority/PgSessionRows.cs`, `dotnet/Foxwarm/Hosted/Postgres/Authority/PgSessionEnvelope.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Authority.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionSegmentPlanner.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityIngress.cs`, `dotnet/Foxwarm.Tests/Hosted/PostgresSessionAuthorityTests.cs`, `dotnet/Foxwarm.Tests/Hosted/PostgresSessionAuthorityStoreTests.cs`, `dotnet/Foxwarm.Tests/Hosted/SessionAuthorityMeasurement.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/PgArchiveTestReader.cs`, `dotnet/Foxwarm.Tests/Storage/SessionSegmentPlannerTests.cs`
Secondary files: `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityDocument.cs`, `dotnet/Foxwarm/Sessions/Turns/PersistentSessionAuthorityStore.cs`, `dotnet/Foxwarm.Tests/Storage/SegmentedSessionAuthority.cs`, `dotnet/Foxwarm.Tests/Storage/SegmentedSessionAuthorityTests.cs`

## Purpose

PostgreSQL implementation of the [Session authority backend](./storage-context.md#stable-symbols-and-callers) for a hosted tenant, in the head-plus-segments representation of [D-session-authority-representations](./storage-context.md#d-session-authority-representations). The authority value, its normalization, the commit classes and the Archive semantics are those of the [file store](./session-authority-store.md); this unit records what the database representation changes. Every write goes through `TenantDb` and its [write fence](./hosted-database.md#d-hosted-write-fence).

## Contracts

### D-hosted-session-tables

**Approved P1 plan §4.1 (user decision U3(b), 2026-11-26).** Migration 0100 creates three tenant tables.

- **`session_heads`**, one row per Session ID: `lifetime_id` (unique, chosen at the first commit), `doc_version`, `commit_id`, `envelope`, `parts`, `segment_ids` and `segment_counts`.
  - The **envelope** is the prepared state without history as compact UTF-8 JSON, keeping the position of the `history` property (null there).
  - **Parts.** Every top-level string member of 4 KiB or more as UTF-8 is stored once per value in `session_envelope_parts` and referenced from `parts` (member name to hex SHA-256); the envelope holds null in its place. The rule is generic, with no field list. Strings that aren't valid UTF-16 stay inline.
- **`session_segments`**, keyed by lifetime and a per-lifetime segment ID: a JSON array of records as the document writer writes them (`codec` 0), compact rather than indented, with its record count and byte length.
- **`session_envelope_parts`**, keyed by lifetime and SHA-256.
- **Compression.** Records, envelope and part values are `bytea` with `lz4` TOAST compression. Segment and part rows are never updated; the runtime role has no `UPDATE` on them.

### D-hosted-session-values

**Approved P1 plan §4.2.** Values equal file mode's by construction.

- **Write.** `SessionAuthorityCodec.PrepareState`, then records through `SessionAuthorityDocument.WriteRecord`, the same validation and serialization the file writer applies.
- **Load.** The raw document is assembled (envelope, parts restored in place, records in head order) and goes through `SessionAuthorityReader.Normalize`, then `SessionAuthorityIngress`, the image externalization and snapshot mapping shared with the file store.
- **Content errors** (unparsable envelope or segment, a missing segment or part, an unknown codec) are `SessionAuthorityUnavailableException`, as an unreadable file is. Database unavailability is not mapped; it stays a global failure.
- A missing head while `archive_messages` has rows for the Session ID is unavailable, not empty, as in file mode.

### D-hosted-session-commit

**Approved P1 plan §4.2.** Each commit of a bound store is one `TenantDb.WriteAsync`:

1. The Archive rows through `PgArchiveRows.InsertAsync` (admission runs before the transaction, `PgArchiveBatch.Prepare`).
2. The new segments, then the new parts.
3. Deletion of the replaced segments and the parts no longer referenced.
4. The head: `INSERT` for a new lifetime, otherwise `UPDATE … WHERE session_id, lifetime_id AND doc_version = expected`, raising `doc_version` and setting a fresh `commit_id`. Zero rows throws `SessionHeadChangedException` (an `IOException`, so a precommit failure) and rolls everything back.
5. `COMMIT`.

- **Round trips.** Statements after the Archive insert are sent as one batch. A rewrite sends a batch whenever about 1 MiB of segments is pending, so bound segment data stays bounded; each segment is a materialized `byte[]`.
- **Lost `COMMIT`.** `Verify` looks for the `commit_id`. Found: the commit succeeded and publication proceeds. Not found: the original failure is a precommit failure, and the transaction took its Archive rows with it. Unresolved (`CommitOutcomeUnknownException`) and head conflicts forget the known head.
- **After commit.** `ArchiveCommitted` runs as in file mode (in hosted P1 its Vector work is off), then `PublishProjection`; a projection failure is `AuthorityCommittedException` (plan C2).
- **Compaction** checks its cancellation token after the head update, before `COMMIT`; a cancelled compaction leaves nothing.

### D-hosted-session-delta

**Approved P1 plan §4.2; the planner is shared product code.** A store keeps the last head it committed or loaded together with that history root. `SessionSegmentPlanner.Plan` finds the reference-identical prefix and keeps the whole segments inside it; the rest is written. Without a known head (a store that hasn't loaded, or after a conflict), the commit reads the head `FOR UPDATE` and replaces it completely, which is the file mode's whole-document overwrite.

Segment policy (thresholds go through the coordinator):

- Written records are cut by `SessionSegmentPlanner.Cut` into segments that close once they reach 256 KiB, so an append of a normal step is one segment.
- When the commit writes records and 16 or more trailing kept segments are each below 64 KiB, they join the written records.
- Saves without history change write only the head, plus a part when a large member changed.

### D-hosted-session-operations

**Approved P1 plan §4.3.**

| Operation | PostgreSQL |
|---|---|
| Identity move (`MoveIdentity`) | `UPDATE session_heads SET session_id`; a head already stored under the target is deleted first, as the file rename replaces it; a missing source is a no-op. `doc_version` is unchanged, so the rebound owner keeps its known head. |
| `ReplaceRaw` | The given document as stored: envelope and parts from it, all records as fresh segments, the old ones deleted, in one transaction. A non-array `history` is refused. |
| `ReadEnvelope` | Head and parts only, validated with `ValidateState` against the head's record count. |
| `ReadRawAsync` | The assembled document in a `REPEATABLE READ` snapshot; `Locator = session_authority/<id>`. |
| `DeleteAuthority` | Head, segments and parts in one transaction; `removed` runs after `COMMIT`, which is also the durable stage. Archive rows stay. |
| `DeleteLegacyArtifacts` | `removed` only. |
| Fork child, clear | Ordinary commits: a child's first commit writes all records into its own lifetime; a clear keeps no segment. |

### D-hosted-session-wiring

**Derived.** `PostgresStorageContext.Authority.cs` builds the backend only when the context has an Archive store, because the authority exposes the Archive store's view of the rows it writes (`ISessionAuthority.Archive`). Until the Archive store is integrated the authority stays in `Missing`. The provider variant cache of `ImageBlobStore` lives in the replica's scratch directory; originals go to the context's image blob store.

## Tests

- `PostgresSessionAuthorityContractTests` runs the shared `SessionAuthorityContractTests` on the fixture, with the Archive rows read through the interim `PgArchiveTestReader` until the Archive track's `IArchiveSession` is integrated.
- `PostgresSegmentedAuthorityCountTests` runs the shared value-equality and rewrite-count cases (`SegmentedAuthorityCountTests`, also run over the in-memory `SegmentedAuthorityBackend`).
- `PostgresSessionAuthorityStoreTests`: every write fenced after a takeover with all tables unchanged; a lost `COMMIT` in both directions through `PgTcpProxy`; parts written once per value, deleted when unreferenced, and byte-identical raw and envelope values against file mode; the merge and 256 KiB cut over real rows; cancelled compaction; a head changed behind a store; identity moves over an existing target; deletion of every row; a missing segment.
- `SessionSegmentPlannerTests`: the planner and the cut without a store.
- `SessionAuthorityMeasurement` runs only with `FOXWARM_SESSION_MEASURE_DIR` set: the p1-plan §4.4 measurement over a directory of Session documents, writing aggregate JSON to `FOXWARM_SESSION_MEASURE_OUT`.

## Open Questions

- The Session lifecycle classes (fork, clear, compact, identity move and recovery) qualify as `Backend=neutral` once the Archive store and identity ledger are integrated and the test backend treats Authority, Archive and Identities as one group.
