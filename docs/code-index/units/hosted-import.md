# Unit: Hosted import of a file-mode installation

Files: `dotnet/Foxwarm/Hosted/Import/HostedImport.cs`, `dotnet/Foxwarm/Hosted/Import/ImportRun.Phases.cs`, `dotnet/Foxwarm/Hosted/Import/ImportRun.Verify.cs`, `dotnet/Foxwarm/Hosted/Import/ImportSource.cs`, `dotnet/Foxwarm/Hosted/Import/ConfigSplit.cs`, `dotnet/Foxwarm/Hosted/Import/ImportTables.cs`, `dotnet/Foxwarm/Hosted/Import/ImportJson.cs`, `dotnet/Foxwarm/Hosted/Import/ImportReport.cs`, `dotnet/Foxwarm/Hosted/Postgres/Journal/PgLlmJournalStore.Import.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportTests.Synthetic.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedImportS3Tests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.Import.cs`, `dotnet/Foxwarm.Tests/Hosted/ImportFixture.cs`, `dotnet/Foxwarm.Tests/Hosted/ImportFixture.Build.cs`
Secondary files: `dotnet/Foxwarm/Hosted/HostedCli.cs`, `dotnet/Foxwarm/Hosted/Lease/TenantLease.cs`, `dotnet/Foxwarm/InstallationLock.cs`, `dotnet/Foxwarm/Program.cs`, `scripts/foxwarm.js`, `scripts/model.test.js`

## Purpose

`foxwarm hosted import --data-root <dir> [--tenant <name>] [--journal] [--dry-run] [--report <file>] [--deployment-config <file>]` copies a stopped file-mode installation into one hosted tenant, verifies the copy against the source, and only then makes the tenant available to replicas. It is the P1 path from a file installation to [hosted mode](./hosted-runtime.md); exporting a tenant back to files and incremental imports aren't part of P1.

## D-hosted-import

**Approved P1 plan §9 and design §8.1, with the mechanics below derived from them.**

- **The source is read-only.** The import holds the installation lock (`InstallationLock.HoldExisting`: the existing `state/main.lock`, opened read-only and unshared), so Main can't start while it runs. A missing `main.lock` refuses and names the file; every installation a current Main has run has one. SQLite stores are copied with their write-ahead logs into a work directory and checkpointed there, so the copy holds every committed transaction without touching the source. Nothing under the data root is created, changed or removed.
- **Tenant states.** The import creates the tenant as `importing`, or takes an existing empty one (`foxwarm db migrate` creates the configured tenant empty). No replica acquires an `importing` tenant ([D-hosted-lease](./hosted-runtime.md#d-hosted-lease) requires `active`). The import holds the tenant lease as `import:<uuid>` at a raised epoch (`TenantLease.TryAcquireForImportAsync`), so every write passes the [write fence](./hosted-database.md). After verification, `TenantLease.ActivateImportAsync` checks the lease, sets the tenant `active`, releases the lease and notifies standbys in one transaction.
- **Roles.** The runtime role writes the tenant rows, so row-level security and the fence trigger apply as for a replica. The migrating role only changes the tenant's state and advances identity sequences past the copied values.
- **No partial retry.** An import refuses a tenant that holds rows. A failed or fenced import leaves its tenant `importing`; the retry uses a new `--tenant` name, or a dropped and recreated database. The import is therefore one pass with no resumption state.
- **Exit codes.** 0 imported or dry run; 1 failed, including verification failures; 75 fenced (the lease was taken over); 78 refused before any write.
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

In dependency order: keys (the source key is adopted as the tenant key), Agent metadata, catalog, Session authority documents (`ReplaceRaw` through the segment planner of the [hosted authority](./hosted-session-authority.md)), Archive rows (`PgArchiveRows.Insert`), identity ledger, Tasks (parents first) and notes, timers, ToolScript runs, Activity direct effects, the LLM journal, the text-redaction cache, secrets and OAuth grants (byte for byte), configuration documents, the Node registry and instance credentials, channel bindings, and blobs.

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

The report lists these with counts and reasons: Agent folders (Q1: the operator copies them to the `FOXWARM_AGENTS_DIR` volume before the first replica starts), Vector data (P3, re-derived from the Archive), the exec registry, the derived activity index `archive_tool_effects` and Vector checkpoints (rebuilt in P3), legacy JSONL import markers, the journal's requests, attempts and objects without `--journal`, legacy frontier files, the removed Session Worker store, logs, migration backups and markers, and other files with no hosted owner.

## CLI

`HostedCli` handles `hosted import` with the application and migrating database URLs and the key-encryption keys of the [hosted bootstrap](./hosted-database.md). `Program` routes `db` and `hosted import` to it. The `foxwarm` JavaScript bin passes `db` and `hosted` to the managed binary unchanged ([CLI frontends](./model-cli.md)).

## Tests

`HostedImportTests` uses a fresh database per test and `ImportFixture`, a synthetic installation written by the file stores themselves: a completed turn through `SessionManager` against a scripted provider, Tasks with a parent and a note, a timer, a ToolScript run, a direct effect, a secret, an OAuth grant, a redaction entry, instance credentials, the Node registry, configuration with comments, deployment-only and refused settings, a stdio MCP server, an image and an artifact. The tests cover a clean import with the source tree unchanged (hashes, sizes and modes); C4 (same key ID, secrets byte-equal and resolving, same placeholders); dry run; every preflight refusal; the existing-tenant refusal; and fencing through a lease takeover between phases. `HostedImportS3Tests` imports blobs to S3 and parses the draft's `blobs` block. `HostedStartupTests.Import` starts a replica on an imported tenant with the imported HTTP token and reads a Session's history. `FOXWARM_IMPORT_GOLDEN` names a copy of a real installation for an optional end-to-end run, and `FOXWARM_IMPORT_REPORT_DIR` keeps its report.
