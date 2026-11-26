# Unit: Storage context and store interfaces

Files: `dotnet/Foxwarm/Storage/StorageContext.cs`, `dotnet/Foxwarm/Storage/ConfigDocuments.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityBackend.cs`, `dotnet/Foxwarm/Sessions/Storage/FileSessionAuthorityBackend.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionAuthorityCodec.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionQueueJson.cs`, `dotnet/Foxwarm/Sessions/Storage/ArchiveStore.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveStore.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveMessageStore.Session.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalogStore.cs`, `dotnet/Foxwarm/Sessions/TaskRows.cs`, `dotnet/Foxwarm/Sessions/SqliteTaskRowStore.cs`, `dotnet/Foxwarm/Models/LlmJournalStore.cs`, `dotnet/Foxwarm/Models/LlmRequestJournal.Store.cs`, `dotnet/Foxwarm/Models/TextRedactionRecords.cs`, `dotnet/Foxwarm/Storage/StateDocuments.cs`, `dotnet/Foxwarm/Storage/InstanceCredentials.cs`, `dotnet/Foxwarm/Storage/BlobStore.cs`, `dotnet/Foxwarm/Images/ImageBlobFiles.cs`, `dotnet/Foxwarm/Artifacts/ArtifactBlobFiles.cs`, `dotnet/Foxwarm/Sessions/AgentFiles.cs`, `dotnet/Foxwarm.Tests/Storage/SessionAuthorityContractTests.cs`, `dotnet/Foxwarm.Tests/Storage/SegmentedSessionAuthority.cs`, `dotnet/Foxwarm.Tests/Storage/SegmentedSessionAuthorityTests.cs`, `dotnet/Foxwarm.Tests/Storage/FileSessionAuthorityBackendTests.cs`, `dotnet/Foxwarm.Tests/Storage/TaskRowStoreTests.cs`, `dotnet/Foxwarm.Tests/Storage/StateDocumentsTests.cs`, `dotnet/Foxwarm.Tests/Storage/InstanceCredentialsTests.cs`, `dotnet/Foxwarm.Tests/Storage/AgentFilesTests.cs`, `dotnet/Foxwarm.Tests/Sessions/FileAuthorityTestExtensions.cs`
Secondary files: `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionIdentityMoveJournal.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.cs`, `dotnet/Foxwarm/Sessions/UsageOverview.cs`, `dotnet/Foxwarm/Sessions/TaskStore.cs`, `dotnet/Foxwarm/Secrets/InstanceSecrets.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptRunStore.cs`, `dotnet/Foxwarm/Secrets/InstanceKeys.cs`

## Purpose

Domain code reaches persistent state through storage interfaces instead of data-root paths, so a database-backed implementation can be added without changing domain logic. `IStorageContext` holds one runtime's stores. `FileStorageContext` is file mode: the files and SQLite databases under one data directory, implemented by the existing store classes. The context holds the Session authority backend, the Archive, the identity ledger, the Session catalog, the Task rows, the model request journal, ToolScript run records, the state documents, the instance credentials and the image and artifact blob stores. Agent memory reads go through an Agent file store built from the Agent catalog.

## D-storage-seams

**Derived design.** [2026-11-26] Each store's interface sits at its existing class boundary, except small whole-document state, which shares one interface ([D-state-documents](#d-state-documents)). The file implementation is today's code, including its failure classification. Interfaces carry no tenant or fencing parameters; a database context binds them per instance. Pure validation and value mapping (`SessionAuthorityCodec`, `SessionQueueJson`, `SessionAuthorityReader.Normalize`, `SessionAuthorityDocument` validation) stay shared static code, so every representation stores and loads the same value.

`SessionManager` builds a `FileStorageContext` from its data root unless a context is supplied. The atomic-write and canonical-commit test hooks belong to that file context (`FileStorageOptions`). Constructing a file context performs no I/O; `SessionManager` still disposes the catalog when it stops.

File members that exist only for inspection, fixtures and test hooks (the SQLite paths, `SessionCatalog.Upsert`, `QueryObserved`, `BeforeAuthorityProjection`, `Explain`, Vector checkpoints) stay off the interfaces; tests reach them through the casts in `FileAuthorityTestExtensions`.

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

### Archive

- `IArchiveStore.ForSession` opens one Session's `IArchiveSession` without I/O: the message, block and branch reads and writes of [the Archive message store](./archive-message-store.md), with identical semantics (immutable rows, exact replay, conflict failure, attempt-owned rollback). `SqliteArchiveMessageStore` implements it explicitly over its existing members. Session owners, `ISessionAuthority.Archive`, compaction and Archive tools, continuous history and Main-side Vector recall use the interface.
- The store's installation-level operations replace the Archive SQL that Main ran on its own connections. The SQL moved unchanged into `SqliteArchiveStore`:
  - `AcquireWriter`: the runtime's writer lease.
  - `ResolveCommittedIdentity`: execution-lifetime checks and recovery direction.
  - `HasLifetimeRowsAsync`: the Archive half of identity reservation.
  - `SequenceCounts`: catalog message counts.
  - `RenameIdentity`: identity move and recovery.
  - `OpenIdentityReader`: usage-overview ownership.
  - `OpenSequenceReader`: the WebUI sequence view.
- Not rerouted: the Vector owner (`VectorService`, `VectorRuntime`, lexical indexing) opens the Archive by path, because it may run in a separate process; Archive migration, import, export and the archive CLI are file-mode tools; and the [activity index](./activity-index.md) still opens the Archive file for its derived tool-effect tables.

### Identity ledger

`IIdentityLedger` covers startup identity evidence, reservations of retired IDs, rename validation and commit, the pending identity-move record and the artifact move that carries it out. `FileIdentityLedger` combines `CommittedArchiveIdentity` and `SessionIdentityMoveJournal` unchanged ([identity moves](./archive-identity-and-moves.md)). `MoveArtifacts` takes the authority move as a callback, so the ledger never reaches the authority itself.

### Session catalog

`ISessionCatalogStore` is the instance surface of `SessionCatalog` used by Main: authority publication, identity rewrite, exact and alias resolution, topology, list, group, activity and sequence queries, presentation mutations, deletion, the `Changed` event and the presentation-mutation hook. `Exists` and `OpenIdentityRecovery` serve pending identity recovery. Projection rules and value helpers stay static on `SessionCatalog` ([projections](./session-catalog-projection.md), [mutations](./session-catalog-mutations.md)). Migration and upgrade inspection construct their own `SessionCatalog`.

### Tasks

`TaskStore` keeps every Task rule: validation, permissions, status and assignment transitions, notification and reminder state, and legacy goal migration. It reaches rows only through `ITaskRowStore` (`Sessions/TaskRows.cs`): `Exists` and `Run(TaskRowAccess, …)` give an `ITaskRows` inside one direct, read or write transaction, with row reads, inserts, field updates, notes, notification settlement, filtered lists and counts, children and the legacy-goal lookup. `SqliteTaskRowStore` holds the SQL, schema and migrations unchanged. A database store implements only the rows, so the rules aren't duplicated. `TaskService` receives the row store from the context.

### Model request journal and text redaction

`ILlmJournalStore` (`Models/LlmJournalStore.cs`) is what Main uses of the request journal: request admission, attempt starts and results, chat results, redaction records, reconstruction and listing, usage backfill, and the usage and redaction queries with their change events. `LlmRequestJournalStore` implements it explicitly ([model request journal](../threads/model-request-and-streaming.md)). Legacy JSONL migration, the SQLite authority marker and export stay on the file class; startup runs the migration only for a file journal.

`ITextRedactionStore` (`Models/TextRedactionRecords.cs`) is the slot and known-original cache of `TextRedactor`; `TextRedactionStore` implements it unchanged ([persistence](./model-text-redaction-persistence.md)). The same slot digest must return the same ranges after a restart. `InstanceSecrets` opens it through an injectable opener that receives the derived key.

### ToolScript run records

`IToolScriptRunStore` covers the per-run lane, existence, read, owner listing and atomic replace of run records under the run's data budget. `ToolScriptRunStore` (`state/toolscript-runs/<runId>.json`) implements it; `MainToolScript` receives it from the context ([ToolScript](./toolscript.md)). The record path and the write-stage hook stay on the file class for tests.

### State documents

`IStateDocuments.Open(StateDocumentName)` returns an `IStateDocument` for one whole document: `Exists`, `ReadText`, `ReadFirstAvailable` (the current version, then retained backups), `ReplaceText` (atomic; a failure after publication is `AuthorityCommittedException`) and `EnsureDurable`. Parsing, validation, caching and write serialization stay in the owning class:

| Name | File | Owner | File rules kept |
|---|---|---|---|
| `Timers` | `state/timers.json` | `MainTimers` | absent only under a directory parent ([timers](./tasks-timers.md)) |
| `RunningExec` | `state/running-exec.json` | `LocalExecManager` | missing path reads as absent ([local exec](./tools-local-io.md)) |
| `Channels` | `state/channels.json` | `SessionDeletionChannels` | missing path reads as absent ([deletion storage](./session-deletion-storage.md)) |
| `Nodes` | `state/nodes.json` | `ApprovedNodeRegistry` | owner-only, three rotated backups plus the legacy `.bak`, fallback reads ([external Nodes](./external-nodes.md)) |
| `McpOAuth` | `state/mcp-oauth.json` | `McpOAuthService` | owner-only ([MCP OAuth](./dotnet-mcp-oauth.md)) |
| `Agents`, `Installation` | `state/agents.json`, `state/installation.json` | `AgentCatalog` | reader-level fence unchanged ([Session domain](./session-domain.md), [isolation migration](./isolation-migration.md)) |
| `Secrets`, `SecretExposures` | `state/secrets.json`, `state/secret-exposures.json` | `SecretStore`, `SecretExposures` | owner-only ([secrets](./dotnet-secrets.md)) |

The Node registry's write-stage hook is the registry's `WriteStage` test property.

### Secrets and instance credentials

- `IKeyRing` (`Secrets/InstanceKeys.cs`) is where the installation master key lives: `Exists` and `OpenOrCreate`. Derivation stays on `InstanceKeys`. `FileKeyRing` is `keys/secrets.key`. `InstanceSecrets` keeps the rule that a missing key is never re-created while an encrypted store exists.
- `IInstanceCredentials` (`Storage/InstanceCredentials.cs`) reads or creates, once and owner-only, the HTTP token, the Node pairing token and the Node event capability secret. Callers trim and validate. `FileInstanceCredentials` keeps each file's existing creation and decoding (strict UTF-8 for the two tokens; the capability secret is created exclusively, flushed and its directory synced). `HttpServerSettings`, `ApprovedNodeRegistry` and `RemoteExecAuthority` take it; the Node hub receives the context's.
- `InstanceSecrets` and the HTTP settings are built by the host entry before `SessionManager` and its context exist, so they default to file implementations of the key ring, documents and credentials from the data root. A database composition passes its own.

### Configuration documents

- `IConfigDocumentStore` (`Storage/ConfigDocuments.cs`) holds the documents Setup and `set_config` install: `Config`, `Models`, `ToolAuthorization`, `Mcp` and `WebUi` (closed `ConfigDocumentName` set). A document is verbatim bytes; owners keep their own parsing, validation and decoding (`ConfigDocumentText.Decode` decodes like `File.ReadAllText` with UTF-8). Operations: `Exists`, `Read`, `ReadBounded` (the policy read), `ReplaceAsync` (atomic; `AuthorityCommittedException` when only final durability failed), `TryCreateAsync` (create unless present), `Locator`/`PhysicalPath` and `DirectEdits`.
- `FileConfigDocuments` is today's files: `state/config.yaml` (or the captured `HostPaths.ConfigPath`), `state/models.yaml`, `state/tool-authorization.yaml`, `state/webui.json` and the configured MCP path. They are owner-only except the WebUI settings. `ReadBounded` keeps the policy file checks: a regular file that is absent only when missing, a regular-file handle and the byte limit while reading.
- **Callers.** `ModelConfiguration.Documents` serves the app and models documents (startup read, `Capture`, Setup diagnostics and first run, installation, first-run seed, secret sources). `SessionManager.ConfigDocuments` serves `ToolAuthorizationAuthority`, `McpConfiguration` and the WebUI settings: it is the configuration owner's store when that isn't the file store, otherwise the manager's own data-root files, as before. `ActivePath`, `AppPath`, `McpConfiguration.FilePath` and `ToolAuthorizationAuthority.PolicyLocator` are locators. `PolicyPath` is the physical policy file, null when the policy isn't a file; only then does the `policy-read` operation rule have nothing to protect.
- **Freshness.** `ToolAuthorizationAuthority` re-reads a policy that allows direct edits after 10 s; without direct edits the cached policy holds until the installation's invalidation.

### Blobs

`IBlobStore` (`Storage/BlobStore.cs`) holds immutable content under string keys: `Exists`, `CreateAsync` (create once; an existing key is kept and reported, or refused), `ReadAllAsync`, `OpenRead`, `List` (keys directly under a prefix) and `LocalPath` (the local file for zero-copy sends, null when blobs aren't local). The context has one store per use:

- **Image originals:** `ImageBlobFiles` keeps `state/image-blobs/<first two>/<blob ID>`, its containment check, flushed writes and directory syncs up to `state/`. `ImageBlobStore` keeps blob IDs, verification of an existing blob's bytes, and legacy path references, which exist only in file mode ([images](./images.md)). WebUI blob routes use `Exists`; channel image delivery uses `LocalPath`. The provider variant cache stays a local per-process cache. Session authority stores receive the same blob store through the authority backend.
- **Artifacts:** `ArtifactBlobFiles` keeps the owner-only directories and files under `state/artifacts`, keyed `<artifact ID>/<revision>.json` and `<artifact ID>/resources/<SHA-256>`. `ArtifactStore` keeps validation and per-artifact ordering; resources are created before the exclusively created revision ([artifacts](./dotnet-artifacts.md)).

### Agent memory files

`IAgentFileStore` (`Sessions/AgentFiles.cs`) gives read access to Agent memory and the installation prompt files: `Locator`, `FileExists`, `ReadTextAsync` and `List` (entries directly in a directory, optionally only files matching a platform name pattern, with link flags so callers can reject or skip links). A null Agent addresses the installation level beside the Agent folders. `AgentMemory` composes the system prompt through it (the framework copies, `00_SYSTEM.local.md`, and inherited `memory/*.md` in ordinal order, rejecting links), and the memory manifest walks it, skipping links. The prompt shows each file's locator, so `FileAgentFiles` returns exactly the paths shown before ([D-request-prefix-stability](../overview.md#d-request-prefix-stability)). The bundled framework template is a program resource and selected-memory paths are caller-chosen paths; both stay file reads. `FileAgentFiles` is built from the `AgentCatalog` layout, so it isn't a context member yet.

## D-state-documents

**Derived design.** [2026-11-26] Chosen instead of one interface per state file. Timers, the running-exec registry, channel bindings, the Node registry, MCP OAuth grants, Agent and installation metadata and the encrypted secret documents share one semantics: read the whole document, replace it atomically. One `IStateDocuments` store serves them, with a closed name set: a name is added with its owning class, never chosen by a caller. The file implementation keeps each file's existing failure classification and file mode as per-name rules. A database context maps it to one documents table keyed by tenant and name, with replace under the tenant's lease fence.

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

[2026-11-26] Hosted P1 keeps these sequences over database stores (plan C2); the authority's own commit is one `TenantDb` transaction ([hosted database](./hosted-database.md), [hosted context](./hosted-runtime.md#d-hosted-storage-context)).

### Configuration split (bootstrap, deployment, tenant)

This classification of current settings is for a hosted mode; file mode reads all of them from one configuration as today.

- **Bootstrap** (process environment, needed before any store opens): data directory selection (`FOXWARM_DATA_DIR`, the `data_dir` pointer), `paths.agentsDir`, `paths.skillsDir`, `paths.mcpConfigPath`, `bot.httpHost`, `bot.httpPort`, the storage selection and its connection settings (new), and the secret-key source.
- **Deployment** (operator-owned, shared by all tenants): `url`, `dbWorkers`, `sessionWorkers`, `vector` (endpoint and index switches), `vectorMaintenance`, `asrService`, `nodeProviders`, `claudeCode`, `bot.enableWebUI`, `bot.enableTrigger`, `bot.enableTUI`, the model provider registry and credentials in `models.yaml` where the operator supplies them, and global skills and the framework prompt addition.
- **Tenant** (per installation in a hosted deployment): `bot.name`, `access`, `channels`, `agentTree`, `nodeTree`, `agentDefaultNode`, `handoffConfirmation`, `sessionAutoTitle`, the compaction and memory thresholds under `llm`, tool authorization, MCP server configuration, and tenant-supplied model entries and keys.
- **Retired or legacy:** `llm.ollamaBaseUrl`, `llm.contextLimit`, `llm.maxOutput`, `llm.providerImageOutputFormat`, and the `llm` provider URL and key fields. They are read for compatibility and don't need a hosted home.

Open: whether tenants may bring their own model providers or only select from operator-provided ones, and whether `nodeProviders` is ever tenant-scoped.

### Configuration documents

[2026-11-26, resolved in hosted P1] The seam exists: [configuration documents](#configuration-documents). Original deferral note: deferred to the hosted phase that splits the configuration (P1). `config.yaml`, `models.yaml`, `tool-authorization.yaml`, `mcp.json` and `webui.json` stay file reads in their owners. The split decides which keys stay in deployment files and which move to tenant documents, so a whole-file seam now would be reshaped. The tool-authorization policy has physical-file guarantees that a tenant-policy store must replace with equivalent ones, not drop: the native file-kind check (a regular file, absent only when missing), the regular-file handle check, the byte limit, and the `policy-read` operation rule that protects the physical `PolicyPath` from Agent tools ([tool authorization](./tool-authorization.md), [operation rules](./tool-operation-rules.md)).

### Agent folders beyond memory reads

Deferred to the P2 Agent store and `$fw_agentdir` work [2026-11-26]:

- **Skills.** Skill catalogs mix program-resource global skills with Agent skills, and skill runs, resource copies to Nodes and skill scripts work on real file paths.
- **Memory tools.** `ctl memory` read, write, edit, delete and patch share `FileToolCore` and `FileToolWrite` with the workspace file tools, check symbolic-link parents, and decide tool authorization on physical paths.
- **The Agent directory lifecycle in `AgentCatalog`:** discovery by directory enumeration, ownership proof markers, preparation directories published by rename, the symbolic-link-preserving memory copy, and the framework-copy migration. A database Agent representation replaces these rather than wrapping them.

### Activity index

The [activity index](./activity-index.md) keeps opening the Archive SQLite file for its derived tables [2026-11-26]. It gets its own rebuildable interface together with the Vector boundary in P3.

### Capability profiles

A runtime without a `master` Node (every hosted installation) needs a capability profile fixed when the runtime is built. It decides whether Main-local file tools and exec, stdio MCP servers, executable Node Providers and the Claude Code runtime exist. Default tool declarations must stay byte-identical for an unchanged profile ([D-request-prefix-stability](../overview.md#d-request-prefix-stability)). File mode has nothing that reads a profile yet, so none exists; it arrives with the first runtime that has no `master`.

## Tests

`SessionAuthorityContractTests` (abstract) runs as `FileSessionAuthorityContractTests` and `SegmentedSessionAuthorityContractTests`. `SegmentedSessionAuthorityTests` compares the segmented value with the file document after the same commits and counts what each kind of commit rewrites. `FileSessionAuthorityBackendTests` covers the file backend's own reads, moves and deletion stages. `TaskRowStoreTests` runs one Task action sequence over the SQLite rows and test-only in-memory rows and requires identical results. `StateDocumentsTests` covers absence, replacement, owner-only mode, the timers' parent rule and the Node registry's backup fallback. `InstanceCredentialsTests` covers create-once, owner-only mode and strict decoding. `AgentFilesTests` pins the prompt locators to the existing paths and covers link reporting in listings. `FileAuthorityTestExtensions` exposes the file paths that file-mode tests stage or inspect.
