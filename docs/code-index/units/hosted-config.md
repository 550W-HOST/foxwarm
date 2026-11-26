# Unit: Hosted configuration, deployment split and tenant keys

Files: `dotnet/Foxwarm/Hosted/Config/DeploymentConfiguration.cs`, `dotnet/Foxwarm/Hosted/Postgres/Config/PgConfigDocuments.cs`, `dotnet/Foxwarm/Hosted/Postgres/Keys/HostedKeyRing.cs`, `dotnet/Foxwarm/Hosted/Postgres/Keys/PgInstanceCredentials.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Config.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0600_config_documents.sql`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0601_tenant_keys.sql`, `dotnet/Foxwarm/Models/AppConfigurationSplit.cs`, `dotnet/Foxwarm.Tests/Storage/ConfigDocumentsContractTests.cs`, `dotnet/Foxwarm.Tests/Hosted/DeploymentConfigurationTests.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantKeysTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.Configuration.cs`
Secondary files: `dotnet/Foxwarm/Storage/ConfigDocuments.cs`, `dotnet/Foxwarm/Models/ModelConfiguration.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationAuthority.cs`, `dotnet/Foxwarm/Secrets/InstanceKeys.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/Hosted/HostedBootstrap.cs`, `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/Hosted/HostedCli.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedTestBackend.cs`

## Purpose

A hosted tenant's configuration and secrets live in the database, beside an operator-owned deployment configuration that every replica mounts. This unit owns how the two are split and combined, the PostgreSQL configuration documents, and the tenant's data key and instance credentials. The document seam itself is in [storage context](./storage-context.md#configuration-documents); file mode reads and writes today's files through it unchanged.

## D-hosted-config-split

**Approved plan §7 and decision C9, with the deployment allowlist set by the coordinator (2026-11-26).**

- **Deployment configuration.** A YAML file named by `FOXWARM_DEPLOYMENT_CONFIG`, read once at process start by owner and standby alike; a change is a rolling restart. There is no deployment document in the database and no change notification in P1: only the owner serves.
- **Its paths, and nothing else:** `url`, `bot.httpHost`, `bot.httpPort`, `bot.enableWebUI`, `asrService`, `nodeProviders`, `blobs`, `journal.retentionDays`, `health` (`health.port` only).
- **Settings of features hosted mode doesn't have** are refused in both documents, naming the key: `paths`, `sessionWorkers`, `dbWorkers`, `vector`, `vectorMaintenance`, `claudeCode`, `bot.enableTUI`, `bot.enableTrigger`. Any other key in the deployment configuration is a tenant setting and refuses startup (exit 78), naming it.
- **Tenant documents** `config`, `models`, `tool-authorization`, `mcp` and `webui` are rows of `config_documents`. The installer refuses a deployment or unavailable path in the tenant `config` document with a validation error naming it, and a stored document holding one refuses startup.
- **Effective app configuration** = the tenant `config` document with the deployment values laid over it (`AppConfigurationSplit.Merge`). The key sets are disjoint, so the result is unambiguous; `bot` is split by child. `AppConfiguration`, `HttpServerSettings`, the restart comparison and the secret sources read the effective configuration; Setup shows and edits the tenant document only.
- **Listener.** The public listener is `bot.httpHost`/`bot.httpPort` with file mode's validation and default (3001). It feeds the owner's `HttpServerSettings` and a standby's forwarder (`HostedReplicaOptions.PublicEndpoint`).
- **Health port.** `health.port` is required, without a default: the orchestrator's probe spec names the same port. It listens on the public listener's address.
- **Bootstrap variables that stay in the environment:** `FOXWARM_REPLICA_ID`, `FOXWARM_ADVERTISE_ADDRESS` and `FOXWARM_SCRATCH_DIR`, which differ per replica while the deployment file is shared. Added: `FOXWARM_DEPLOYMENT_CONFIG`, `FOXWARM_KEK_FILE`, `FOXWARM_KEK_PREVIOUS_FILE` and `FOXWARM_AGENTS_DIR` (the hosted `HostPaths` agents root; the data root is the scratch directory). `FOXWARM_HEALTH_PORT` is gone.
- **First run.** No documents means today's OOBE: models diagnostics report `oobe`, and the first models installation seeds the `config` document from `templates/config.example.yaml`, which holds only tenant settings.
- **Live application** is today's in-process installer lane: the owner is the only writer, so there is nothing to propagate.

## D-hosted-config-documents

**Approved plan §7 (P0 tool-authorization constraint).**

- **Storage.** `config_documents(name, text, generation, sha256, updated_at, updated_by)`, one row per closed name. `text` is the document's bytes decoded as strict UTF-8, a byte order mark included, so a read returns the installed bytes. Text that isn't UTF-8 or holds NUL is refused. A replacement is one fenced upsert raising the generation; a lost `COMMIT` is resolved by checking generation and SHA-256. Create-if-absent is `ON CONFLICT DO NOTHING`. `updated_by` is the writing replica's name.
- **Tool-authorization guarantees:**

  | File-mode guarantee | Hosted equivalent |
  |---|---|
  | File-kind check (a regular file, absent only when missing) | the row is present or absent; any read failure throws, and two failed reads deny (`ToolAuthorizationUnavailableException`) |
  | Regular-file handle check | the size and the value are read in one statement |
  | Byte limit while reading | the same limit on read (a larger stored value fails closed) and on write (the store and the policy parser refuse it) |
  | `policy-read` rule protecting `PolicyPath` | `PolicyPath` is null: no policy file exists. The `ctl` and Setup operations keep their operation rules |
  | 10 s fresh-read interval | none: `DirectEdits` is false and the cached policy holds until an installation invalidates it |

## D-hosted-tenant-keys

**Design U15(a), plan §7 and decision C4; rotation by owner rewrap (coordinator, 2026-11-26).**

- **KEK.** A file in today's instance key format (`{version, keyId, key}`), read with `InstanceKeys.Read`. The wrapping key is derived from it for the purpose `tenant-key-wrap`. `FOXWARM_KEK_FILE` is required, and both KEK files are checked before a replica stands by.
- **DEK.** `tenant_keys(key_id, kek_id, nonce, wrapped)`, AES-256-GCM with the tenant ID and key ID as associated data, one row per tenant in P1. `InstanceKeys.FromKey` builds the keys from the DEK bytes, so every purpose (secret store, text redaction, instance credentials) derives as in file mode.
- **Opening** (`HostedKeyRing.OpenOrCreate`, at owner startup before the runtime):
  - a DEK wrapped by the current KEK is unwrapped;
  - a DEK wrapped by the previous KEK is unwrapped and rewrapped under the current one, a compare-and-set in an ordinary fenced write at the owner's epoch;
  - no DEK and no encrypted data: one is created (insert if absent, then read back);
  - **locked:** a DEK neither KEK unwraps, or encrypted data (the secrets document, instance credentials, the text-redaction tables when present; `foxwarm_tenant_has_encrypted_data`) without a DEK. Startup refuses with exit 78 and nothing is generated.
- **Rotation.** Mount the new KEK as current and the old one as previous, roll the replicas, then remove the previous KEK. `db status` names the KEK that wraps each tenant's DEK. Re-encrypting data under a new DEK is P3.
- **Import (C4).** `HostedKeyRing.Adopt` stores a file-mode instance key as the DEK with its key ID, so its encrypted data imports byte for byte. Repeating it with the same key is a no-op; a tenant with a different DEK is refused. Consequence: whoever holds the old `keys/secrets.key` can decrypt the imported tenant until a DEK rotation.
- **Instance credentials.** `instance_credentials(name, nonce, value)`, AES-256-GCM under the DEK purpose `instance-credentials` with the name as associated data. Create-once is `ON CONFLICT DO NOTHING` and a re-read, so every replica reads the same HTTP token and derives the same cookie and download keys.

## Hosted runtime wiring

`HostedEntry.CreateRuntimeAsync` still refuses first while the build lacks a PostgreSQL store. `BuildRuntimeAsync` then opens the key ring, builds `ModelConfiguration` over `ConfigurationSources` (the tenant documents, the deployment root, `InstanceSecrets` over the hosted key ring and state documents, the context's credentials) and starts `MainHost` on the deployment listener. Configuration, bootstrap and lock failures are `HostedStartupException` (exit 78). The text-redaction cache is the tenant's PostgreSQL store under the key ring's derived key, and `journal.retentionDays` configures the owner's [journal retention](./hosted-journal.md#journal-retention).

## Tests

- `ConfigDocumentsContractTests` (abstract) runs as `FileConfigDocumentsContractTests` and `PostgresConfigDocumentsContractTests` (`Backend=postgres`, hosted mode): verbatim bytes, create-if-absent, bounded reads, app installation with live settings and restart reporting, the first run and its seed, MCP round trip, and the policy guarantees (compatibility when absent, installation applies at once, byte limit, unparseable policy denies). The file subclass adds the hand-edit fresh-read interval; the PostgreSQL one adds refused keys, the effective configuration, a refused stored document, the install-only cache, read failure and oversize read failing closed, non-UTF-8 refusal and fenced writes.
- `DeploymentConfigurationTests`: listener and health port rules, the allowlist and refusals naming the key, disjoint sets and the merge.
- `TenantKeysTests` (`Backend=postgres`): create once, wrong and missing KEK, encrypted data without a DEK, rewrap from the previous KEK, `db status`, bootstrap variables, import adoption with equal derived keys, credentials create-once and ciphertext, and fenced key and credential writes.
- `HostedStartupTests.Configuration`: a first hosted start runs Setup over tenant documents on the deployment listener with the credential token, and a locked tenant exits 78 without generating a key.
