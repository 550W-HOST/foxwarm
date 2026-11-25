# Unit: Storage context and Session authority backend

Files: `dotnet/Foxwarm/Storage/StorageContext.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityBackend.cs`, `dotnet/Foxwarm/Sessions/Storage/FileSessionAuthorityBackend.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityCodec.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionQueueJson.cs`, `dotnet/Foxwarm.Tests/Storage/SessionAuthorityContractTests.cs`, `dotnet/Foxwarm.Tests/Storage/SegmentedSessionAuthority.cs`, `dotnet/Foxwarm.Tests/Storage/SegmentedSessionAuthorityTests.cs`, `dotnet/Foxwarm.Tests/Storage/FileSessionAuthorityBackendTests.cs`, `dotnet/Foxwarm.Tests/Sessions/FileAuthorityTestExtensions.cs`
Secondary files: `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionIdentityMoveJournal.cs`

## Purpose

Domain code reaches persistent state through storage interfaces instead of data-root paths, so a database-backed implementation can be added without changing domain logic. `IStorageContext` holds one runtime's stores. `FileStorageContext` is file mode: the files and SQLite databases under one data directory, implemented by the existing store classes. The context currently holds the Session authority backend. Other stores join it as they get their interfaces.

## D-storage-seams

**Derived design.** [2026-11-26] Each store's interface sits at its existing class boundary. The file implementation is today's code, including its failure classification, and is not a generic document store. Interfaces carry no tenant or fencing parameters; a database context binds them per instance. Pure validation and value mapping (`SessionAuthorityCodec`, `SessionQueueJson`, `SessionAuthorityReader.Normalize`, `SessionAuthorityDocument` validation) stay shared static code, so every representation stores and loads the same value.

`SessionManager` builds a `FileStorageContext` from its data root unless a context is supplied. The atomic-write and canonical-commit test hooks belong to that file context (`FileStorageOptions`).

## Stable symbols and callers

- `ISessionAuthorityBackend.Open` binds an `ISessionAuthority` to one Session lifetime without I/O. `SessionManager.MakeStore` is the only production caller; owner rehydration also goes through it. The Main-owned callbacks (`SessionAuthorityCallbacks`) receive the store's current Session ID, which an identity move can rebind.
- `ISessionAuthority` is the commit and load surface used by `SessionSaveLane`, `SessionRegistry`, `SessionCompactor` and the turn hosts. `PersistentSessionAuthorityStore` is its file implementation ([Session authority store](./session-authority-store.md)).
- The backend's own operations replace every direct `state/sessions` access outside the file implementation:
  - `Exists` is used by identity reservation.
  - `ReadEnvelope` is used by the Task anchor sequence.
  - `ReadRawAsync` and `ReplaceRaw` are used by the administrator debug view and pending-move recovery.
  - `MoveIdentity` is used by identity move and recovery. `SessionIdentityMoveJournal.MoveArtifacts` moves the legacy per-Session artifacts and delegates the authority itself.
  - `DeleteAuthority` and `DeleteLegacyArtifacts` are used by deletion and channel creation compensation. Their `removed` callbacks keep the existing separate "removed" and "durable" deletion stages.
- File-mode-only readers (catalog migration, legacy Archive import, upgrade inspection) still read `state/sessions` directly, because they read upgrade input that a database mode never has.

## D-session-authority-representations

**User decision (2026-11-26) for a database-backed hosted mode; file mode is unchanged.** There, a Session's authority is a document head plus immutable history segments instead of a whole-document save. File mode keeps one complete JSON document per Session, saved in full.

The contract both representations implement:

- **Value.** A Session lifetime has at most one authority value: the validated envelope (settings, queue, meta, waits, counters, …) with an ordered array of immutable history records. Callers see it only as a `SessionSnapshot`. Load applies the same normalization, Main overlay and typed errors in every representation.
- **Commit.** `CommitAsync`, `CommitCanonicalAppendAsync` and `CommitCompactionAsync` take a complete staged snapshot. The commit is all-or-nothing for the value together with the Archive rows it carries.
  - A precommit failure leaves the previous value in place and removes only the Archive rows this attempt inserted.
  - A committed failure surfaces as `AuthorityCommittedException`.
  - Catalog projection follows commit. Archive-committed notification never changes the result.
- **Delta.** A segmented store finds the longest prefix of staged records that are reference-identical to its last committed root; `SessionHistory` shares unchanged records. It keeps the segments inside that prefix and writes the rest. As a result:
  - saves without history changes (queue, waits, busy, settings) write only the head;
  - appends write the appended records;
  - in-place changes, deletions and compaction rewrite from the segment holding the first changed record;
  - a lifetime with no known root writes everything.
  Reference identity is sufficient, not necessary, for equality, so the worst case only rewrites more.
- **Operations.**
  - Identity move: the file implementation renames the file. A segmented one updates the head, because segments are keyed by a lifetime identifier, not by Session ID.
  - Fork child: its first commit writes the child's own records.
  - Clear: commits an empty history; Archive rows stay.
  - Raw read: returns the assembled stored value.
  - Envelope read: returns the value without `history`.
  - Delete: removes the value; Archive rows stay.

The test-only `SegmentedAuthorityBackend` implements this representation in memory over the ordinary SQLite Archive. The contract suite runs every case against both backends.

## Open Questions

### Transaction scope for a database context

There's no cross-store unit of work in file mode: each step is its own durable store call, and pending-move journals and deletion stages provide recovery. A database context is expected to offer one transaction scope wrapping these existing sequences, so each becomes a single commit:

- **Authority commit:** canonical append or compaction Archive rows, the authority head and segments, and the catalog projection.
- **Identity move:** authority head, Archive identity rename, catalog identity rewrite, committed-identity ledger, and channel bindings. The pending-move journal then has nothing to recover.
- **Session and Agent deletion:** authority, catalog rows, channel bindings and Task-ownership effects.
- **Fork:** the child's first authority commit with its Archive branch row and catalog row.
- **Session creation and channel creation compensation.**

Vector indexing stays outside any such scope; it is derived and rebuilt from the Archive.

### Configuration split (bootstrap, deployment, tenant)

This classification of current settings is for a hosted mode; file mode reads all of them from one configuration as today.

- **Bootstrap** (process environment, needed before any store opens): data directory selection (`FOXWARM_DATA_DIR`, the `data_dir` pointer), `paths.agentsDir`, `paths.skillsDir`, `paths.mcpConfigPath`, `bot.httpHost`, `bot.httpPort`, the storage selection and its connection settings (new), and the secret-key source.
- **Deployment** (operator-owned, shared by all tenants): `url`, `dbWorkers`, `sessionWorkers`, `vector` (endpoint and index switches), `vectorMaintenance`, `asrService`, `nodeProviders`, `claudeCode`, `bot.enableWebUI`, `bot.enableTrigger`, `bot.enableTUI`, the model provider registry and credentials in `models.yaml` where the operator supplies them, and global skills and the framework prompt addition.
- **Tenant** (per installation in a hosted deployment): `bot.name`, `access`, `channels`, `agentTree`, `nodeTree`, `agentDefaultNode`, `handoffConfirmation`, `sessionAutoTitle`, the compaction and memory thresholds under `llm`, tool authorization, MCP server configuration, and tenant-supplied model entries and keys.
- **Retired or legacy:** `llm.ollamaBaseUrl`, `llm.contextLimit`, `llm.maxOutput`, `llm.providerImageOutputFormat`, and the `llm` provider URL and key fields. They are read for compatibility and don't need a hosted home.

Open: whether tenants may bring their own model providers or only select from operator-provided ones, and whether `nodeProviders` is ever tenant-scoped.

### Capability profiles

A runtime without a `master` Node (every hosted installation) needs a capability profile fixed when the runtime is built. It decides whether Main-local file tools and exec, stdio MCP servers, executable Node Providers and the Claude Code runtime exist. Default tool declarations must stay byte-identical for an unchanged profile ([D-request-prefix-stability](../overview.md#d-request-prefix-stability)). File mode has nothing that reads a profile yet, so none exists; it arrives with the first runtime that has no `master`.

## Tests

`SessionAuthorityContractTests` (abstract) runs as `FileSessionAuthorityContractTests` and `SegmentedSessionAuthorityContractTests`. `SegmentedSessionAuthorityTests` compares the segmented value with the file document after the same commits and counts what each kind of commit rewrites. `FileSessionAuthorityBackendTests` covers the file backend's own reads, moves and deletion stages. `FileAuthorityTestExtensions` exposes the file paths that file-mode tests stage or inspect.
