# Unit: Hosted import of a file-mode installation

Files: `dotnet/Foxwarm/Hosted/Import/HostedImport.cs`, `dotnet/Foxwarm/Hosted/Import/LeasedImport.cs`, `dotnet/Foxwarm/Hosted/Import/HostedAgentImport.cs`, `dotnet/Foxwarm/Hosted/Import/AgentFolderImport.cs`, `dotnet/Foxwarm/Hosted/Import/PhysicalAgentImport.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.MasterHost.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.MasterVolume.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.Finalization.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedAgentImportTests.cs`, `dotnet/Foxwarm/Hosted/Import/ImportRun.Phases.cs`, `dotnet/Foxwarm/Hosted/Import/ImportRun.Verify.cs`, `dotnet/Foxwarm/Hosted/Import/ImportSource.cs`, `dotnet/Foxwarm/Hosted/Import/ConfigSplit.cs`, `dotnet/Foxwarm/Hosted/Import/ImportTables.cs`, `dotnet/Foxwarm/Hosted/Import/ImportJson.cs`, `dotnet/Foxwarm/Hosted/Import/ImportReport.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/PgLlmJournalStore.Import.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.Synthetic.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportS3Tests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.Import.cs`, `dotnet/Foxwarm.Tests/Hosted/ImportFixture.cs`, `dotnet/Foxwarm.Tests/Hosted/ImportFixture.Build.cs`
Secondary files: `dotnet/Foxwarm/Hosted/HostedCli.cs`, `dotnet/Foxwarm/Hosted/Lease/TenantLease.cs`, `dotnet/Foxwarm/InstallationLock.cs`, `dotnet/Foxwarm/Program.cs`, `scripts/foxwarm.js`, `scripts/model.test.js`

## Purpose

`foxwarm hosted import --data-root <dir> [--profile hosted|operator] [--tenant <name>] [--journal] [--dry-run] [--report <file>] [--deployment-config <file>]` copies a stopped file-mode installation into one hosted tenant, verifies the copy against the source, and only then makes the tenant available to replicas. It is the P1 path from a file installation to [hosted mode](./hosted-runtime.md); exporting a tenant back to files and incremental imports aren't part of P1.

## D-hosted-import

**Approved P1 plan §9 and design §8.1, with the mechanics below derived from them.**

- **The source is read-only.** The import holds the installation lock (`InstallationLock.HoldExisting`: the existing `state/main.lock`, opened read-only and unshared), so Main can't start while it runs. A missing `main.lock` refuses and names the file; every installation a current Main has run has one. SQLite stores are copied with their write-ahead logs into a work directory and checkpointed there, so the copy holds every committed transaction without touching the source. Nothing under the data root is created, changed or removed.
- **Tenant states.** The import creates the tenant as `importing`, or takes an existing empty one (`foxwarm db migrate` creates the configured tenant empty). No replica acquires an `importing` tenant ([D-hosted-lease](./hosted-runtime.md#d-hosted-lease) requires `active`). The import holds the tenant lease as `import:<uuid>` at a raised epoch (`TenantLease.TryAcquireForImportAsync`), so every write passes the [write fence](./hosted-database.md). After verification, `TenantLease.ActivateImportAsync` checks the lease, sets the tenant `active`, releases the lease and notifies standbys in one transaction.
- **Roles.** The runtime role writes the tenant rows, so row-level security and the fence trigger apply as for a replica. The migrating role only changes the tenant's state and advances identity sequences past the copied values.
- **No partial retry.** An import refuses a tenant that holds rows. A failed or fenced import leaves its tenant `importing`; for a hosted tenant the retry uses a new `--tenant` name, or a dropped and recreated database. For the singleton operator tenant see [operator import](#d-hosted-operator-import). The import is therefore one pass with no resumption state.
- **Exit codes.** 0 imported or dry run; 1 failed, including verification failures; 75 fenced (the lease was taken over); 78 refused, including a physical destination conflict at final publication.
- **Report.** An owner-only JSON file (default `foxwarm-import-<tenant>-<UTC time>.json` in the working directory) holds the phases with item counts and timings, refusals, warnings, verification results, the configuration split and the `notImported` inventory. Standard output prints the phases and a summary. `--dry-run` runs preflight, the configuration split and the plan, and writes no row.

## Preflight refusals

Each names the cause and the operator's next step:

- Main holds the lock, or `main.lock` is missing.
- A Session identity move is pending (`state/session-id-move-pending.json`).
- The data directory isn't at the current file format (the SQLite-only Archive migration hasn't completed), the catalog isn't at schema 3, or an authority document has no supported `sessionStateVersion`.
- `state/installation.json` requires a newer reader than this binary.
- `keys/secrets.key` is missing or unreadable. The installation key becomes the tenant data key ([hosted configuration](./hosted-config.md)), so secrets, OAuth grants and the text-redaction cache stay readable without re-encryption.
- The identity ledger (`state/session-id-reservations.jsonl`) and its SQLite mirror differ.
- The configuration can't be split by whole blocks (below).
- The hosted schema isn't compatible with this build, or the tenant holds rows, is leased or is in another state.

## Phases

In dependency order: keys (the source key is adopted as the tenant key), Agent metadata and folders, catalog, Session authority documents (`ReplaceRaw` through the segment planner of the [hosted authority](./hosted-session-authority.md)), Archive rows (`PgArchiveRows.Insert`), identity ledger, Tasks (parents first) and notes, timers, ToolScript runs, Activity direct effects, the LLM journal, the text-redaction cache, secrets and OAuth grants (byte for byte), configuration documents, the Node registry and instance credentials, channel bindings, and blobs.

- **Catalog rows are copied, not re-projected.** Re-projecting from the authority documents would drop `meta.waitLivenessFingerprints`, which only the row holds; verification compares every row and reports how many carry fingerprints.
- **Tables** are copied in batches over the columns both sides have; a source column the hosted table lacks is listed in `notImported`. Identity sequences are advanced past the copied maximum.
- **Journal.** The usage and redaction ledgers are always imported; requests, attempts and objects only with `--journal`. `PgLlmJournalStore.ImportRequestObjects` derives `llm_journal_request_objects`.
- **Blobs** go through the tenant context's `IBlobStore` on the deployment's backend ([hosted blobs](./hosted-blobs.md)). `--deployment-config` supplies the `blobs` block; without it the import uses PostgreSQL. The draft deployment configuration records the backend the import wrote to, so replicas read from the same place.
- **MCP.** stdio servers are dropped from the tenant's MCP document with a warning ([capability profile](./hosted-capabilities.md)).

### Configuration split

`ConfigSplit` cuts `config.yaml` by whole top-level blocks, and by child for `bot`, using `AppConfigurationSplit`'s path classes. Tenant settings stay in the tenant `config` document with their comments. Deployment settings, including `journal`, go to a draft deployment YAML beside the report. Settings hosted mode refuses are dropped and listed with their values. A key's block includes the comment lines directly above it. Both parts must pass their own document's rules, and their merge must equal the parsed original; otherwise the split refuses, since an anchor or alias may cross a cut. The draft leaves the required `health` setting for the operator.

## Verification

Before activation the import reads the tenant back and compares it with the source:

- Each authority document is JSON-equal to the source, with both hashes reported; the catalog rows, their hash and the aliases are equal.
- Every catalog member loads through the hosted authority. A document that fails to load in file mode with the same error is reported under `unloadableInSourceToo` as a warning, not a failure: the import copies, it doesn't repair.
- Row counts and row hashes of each copied table match; every journal request reconstructs identically; configuration and state documents are byte-equal; ToolScript runs, secrets and the key ID, the redaction cache's known entries and blob SHA-256 digests match.

## P1 limitations: not imported

The report lists these with counts and reasons: Vector data (P3, re-derived from the Archive), the exec registry, the derived activity index `archive_tool_effects` and Vector checkpoints (rebuilt in P3), legacy JSONL import markers, the journal's requests, attempts and objects without `--journal`, legacy frontier files, the removed Session Worker store, logs, migration backups and markers, and other files with no hosted owner.

## D-hosted-agent-folder-import

**2026-11-27.** The hosted-profile installation import and the offline Agent-volume import use `AgentFolderImport`. It preserves Agent roots, empty directories, ordinary files and the installation-level files beside the Agent folders. It skips `tmp/` and `.temp/` at each Agent root; it reports symlinks, invalid names, special files, executable files and files above the store limit. It never traverses a directory link. Before activation it reads the source and the store and compares SHA-256 for every admitted file; the owner-only report lists both digests. `--dry-run` of the installation import inventories the files without writing. Both store imports scan using the target tenant’s per-file limit (defaults for a new tenant), then bind all Agent store quotas from the target settings under the import lease. When the plan includes S3-backed Agent content, the importer waits for the operator’s matching inventory before the first import write phase, including key adoption. The import lease renews during the wait. Inline-only and physical Agent folders do not need an object inventory.

The installation import uses `paths.agentsDir` from the offline configuration, with the staged installation root as the source application root for relative paths. A configured root must exist inside the copy, including after resolving path links. If the source setting cannot be resolved against the copy (including a source-home reference), the operator must stage the Agent directory and pass `--agents-dir <path>`. This also selects a separately staged volume. Without a configured or explicit location, `<data-root>/agents` is optional. The Agent-folder scan uses the store's composite index-key bound and reports an unrepresentable subtree at its first unrepresentable entry. File-mode attachments under `.temp/channel-files/` **do not migrate**: the temporary tree is excluded, and old descriptors contain absolute master paths that a hosted runtime cannot resolve.

`foxwarm hosted agents import --tenant <name> --from <dir>` migrates a stopped hosted tenant from its former Agents volume. Both store import commands require a compatible schema and refuse operator-profile targets: the operator's runtime reads physical folders. Acquisition and activation check the target's profile under the tenant lock, before taking the lease lock. Agent-only acquisition and abandon also enforce the tenant's installation reader floor under that lock. A full installation import remains distinct from an Agent-only import and neither command can activate the other's partial data.

The Agent-only command requires an existing hosted tenant with a released or expired lease. It moves an active tenant to `importing-agents` and stores the plan summary in that same transaction: the ordinary-file count, total file bytes, and SHA-256 of the ordinal sorted path list (including directory paths, tagged by their trailing slash). The lease write fence and renewal are shared with the full import. A failed copy leaves the tenant offline. A retry compares the source summary under the tenant lock before claiming the lease; a different or missing summary refuses without advancing the epoch. For a matching plan, existing files still have to match byte for byte. Verification then compares each source and stored hash. Activation releases the lease and clears the plan atomically. `--abandon` lists the files already in place, clears the partial import state and makes the tenant active without changing those files.

## D-hosted-operator-import

With `--profile operator`, a full import creates an operator tenant pinned to `master-host` or takes an empty tenant that already has that profile. Acquisition and activation check profile under the tenant row lock. The partial unique index arbitrates simultaneous operator creates. The configuration split admits the operator keys (including `claudeCode`) and the imported MCP document retains its stdio servers. Structured state and blobs follow the same verified import as a hosted-profile tenant.

`PhysicalAgentImport` inventories the offline Agent root without traversing symbolic links. Ordinary files, directories, rwx modes and literal link targets, including absolute targets, are copied to a private staging directory on `FOXWARM_AGENTS_DIR`. Agent-root `tmp/` and `.temp/` are skipped and special files are reported. Import and startup resolve the existing volume in filesystem order. Import checks writability and directory-sync support before tenant admission, also on dry runs, which create nothing on the volume. File contents are verified by source and target SHA-256; the report lists copied links and the number dangling after publication. Each staged file is flushed to disk after setting its mode; directories are synced bottom-up after verifying the tree. Under the final tenant and lease locks, POSIX `rename` publishes the verified tree at `<tenant_id>/` and syncs the volume directory **before the database commits activation**. An absent or empty directory can receive the rename; if the directory became nonempty, its contents are preserved and the tenant stays offline. The local fence cancels finalization lock waits. The finalizer checks database time after locking the lease and checks the linked token before rename. A crash between rename and commit can leave a complete numeric directory with an incomplete database import. A missing COMMIT reply reports `activation-unknown` with the ID and epoch to inspect. Recovery never undoes publication on that basis.

`foxwarm hosted import --profile operator --tenant <slug> --abandon` takes no source directory. For an incomplete full operator import with a released or expired lease, it removes only that tenant's private staging directories. In one transaction it advances the epoch and records the same deletion epoch, clears the owner, releases the lease and marks the tenant `deleting`. The operator service performs its normal deletion. Once deleted, the tenant can be imported afresh. The offline source and any published numeric directory remain for explicit cleanup. A missing volume refuses cleanup and leaves the tenant offline. A live import, an active tenant or an Agent-only partial import cannot be abandoned this way.

## CLI

`HostedCli` handles `hosted import` with the application and migrating database URLs and the key-encryption keys of the [hosted bootstrap](./hosted-database.md). `Program` routes `db` and `hosted import` to it. The `foxwarm` JavaScript bin passes `db` and `hosted` to the managed binary unchanged ([CLI frontends](./model-cli.md)).

## Tests

`HostedImportTests` uses a fresh database per test and `ImportFixture`, a synthetic installation written by the file stores themselves: a completed turn through `SessionManager` against a scripted provider, Tasks with a parent and a note, a timer, a ToolScript run, a direct effect, a secret, an OAuth grant, a redaction entry, instance credentials, the Node registry, configuration with comments, deployment-only and refused settings, a stdio MCP server, an image and an artifact. The tests cover a clean import with the source tree unchanged (hashes, sizes and modes); C4 (same key ID, secrets byte-equal and resolving, same placeholders); dry run; every preflight refusal; the existing-tenant refusal; and fencing through a lease takeover between phases. `HostedImportS3Tests` imports blobs to S3 and parses the draft's `blobs` block. `HostedStartupTests.Import` starts a replica on an imported tenant with the imported HTTP token and reads a Session's history. `FOXWARM_IMPORT_GOLDEN` names a copy of a real installation for an optional end-to-end run, and `FOXWARM_IMPORT_REPORT_DIR` keeps its report.

`HostedAgentImportTests` exercises CLI retry, conflict, abandon, full-import separation, activation fencing and per-file verification. `FOXWARM_AGENT_IMPORT_GOLDEN` names a standalone offline Agents volume for verification.
