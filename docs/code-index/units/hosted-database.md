# Unit: Hosted database access, schema and fencing

Files: `dotnet/Foxwarm/Hosted/Postgres/PgDatabase.cs`, `dotnet/Foxwarm/Hosted/Postgres/TenantDb.cs`, `dotnet/Foxwarm/Hosted/Schema/SchemaMigrator.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0001_foundation.sql`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0003_cluster.sql`, `dotnet/Foxwarm.Tests/Hosted/ClusterSchemaTests.cs`, `dotnet/Foxwarm/Hosted/HostedBootstrap.cs`, `dotnet/Foxwarm/Hosted/HostedCli.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantDbTests.cs`, `dotnet/Foxwarm.Tests/Hosted/SchemaTests.cs`, `dotnet/Foxwarm.Tests/Hosted/SchemaLint.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedSourceRulesTests.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/PostgresServer.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/PgTcpProxy.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/S3Server.cs`, `dotnet/Foxwarm.Tests/Hosted/S3ServerTests.cs`, `scripts/test/acquire-hosted-fixtures.sh`
Secondary files: `dotnet/Foxwarm/Foxwarm.csproj`, `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/Hosted/Licenses/Npgsql-LICENSE.txt`, `dotnet/Foxwarm.Desktop/Foxwarm.Desktop.csproj`, `dotnet/Foxwarm.Desktop.Mac/Foxwarm.Desktop.Mac.csproj`, `scripts/test/run-tests.mjs`, `scripts/test/managed-preparation.test.mjs`, `.github/workflows/tests.yml`

## Purpose

Hosted mode keeps a tenant's state in PostgreSQL instead of the data directory. One replica owns a tenant at a time, under a lease with an epoch (design U17). This unit owns the parts every hosted store shares:

- the build switch and the client package;
- the connection pool and the only transaction helper;
- the schema migrator and its compatibility fence;
- the rules every tenant table follows, and the database-side write fence;
- the test fixtures.

The store implementations, the lease monitor and the hosted startup build on it.

## Contracts

### D-hosted-build-switch

**User decision (2026-11-26, Q2(b)).** The MSBuild property `FoxwarmHosted` is the single switch for hosted mode.

- **When it's on** (the default: Linux server packages, the image, tests), the build gets:
  - the `Npgsql` package reference and its notice (`Hosted/Licenses`);
  - the embedded migrations;
  - the sources under `Hosted/`;
  - the `FOXWARM_HOSTED` compilation symbol.
- **When it's off** (the Desktop projects set `FoxwarmHosted=false` on their Main reference), none of those are built.
  - `foxwarm db …` reports that the build has no hosted mode, exit 2.
  - Hosted startup fails the same way (hosted startup unit).
- Code outside `Hosted/` reaches hosted types only under `#if FOXWARM_HOSTED`.

Npgsql is pinned to 10.0.4. Npgsql 11 requires `Microsoft.Extensions.*` 11, which is above the ASP.NET 10 shared framework.

### D-hosted-write-fence

**Derived from the approved P1 plan (2026-11-26, C1).** A write of a replica whose lease is no longer current can't commit. That holds also for code that bypasses the helper.

- **Every tenant write transaction sets the GUCs `foxwarm.tenant` and `foxwarm.epoch`.**
  - `TenantDb.Write`/`WriteAsync` sets them with `set_config(…, true)`, which makes them transaction-local.
  - In the same round trip, it checks that the lease row is `active`, unexpired and at this epoch, locking it `FOR KEY SHARE`. That check gives a clean `TenantFencedException` before any work.
  - The synchronous `Write`/`Read` run these setup statements one command at a time (`PgTx.ExecuteInline`) instead of as a batch. Npgsql sends a multi-command batch from a thread-pool task even in a synchronous call, so callers blocked on a lock around synchronous writes can starve the pool and leave the sending thread waiting for its own send until the command timeout. Synchronous store code with several statements uses `ExecuteInline` for the same reason.
- **Every tenant table has the statement-level `BEFORE INSERT OR UPDATE OR DELETE` trigger `foxwarm_fence()`.**
  - It repeats the check with the same lock (`foxwarm_require_lease()`) and raises SQLSTATE `FW001`.
  - The runtime role's cluster-table writes through `SECURITY DEFINER` functions (`foxwarm_raise_reader_version` and the wake-up functions of [cluster tables](#d-hosted-cluster-tables)) run the same check.
  - The helper maps `FW001` to `TenantFencedException` and raises `TenantDb.Fenced`, which the lease monitor uses to fence the runtime at once.
- **Takeover and renewal.**
  - A takeover selects the lease row `FOR UPDATE` before raising the epoch. It therefore waits for every in-flight writer of the old epoch, and none can commit after it.
  - The owner's renewal updates only non-key columns (`expires_at`). `FOR KEY SHARE` doesn't conflict with that, so renewal never queues behind long write transactions.
- **Timeouts.** Each transaction also sets a transaction-local `statement_timeout` (15 s) and `idle_in_transaction_session_timeout` (10 s). The server then ends a partitioned owner's transaction on its own, which bounds how long it can delay a takeover ([self-fence](./hosted-runtime.md#d-hosted-self-fence)).
- **Reads** (`Read`/`ReadAsync`) set only the tenant, run `READ ONLY` (`REPEATABLE READ` with `snapshot: true`), and need no lease.
- **Closing.** `Close()` makes the helper refuse every later transaction. Self-fencing uses it.
- **Statement cap (plan §7.2).** A `TenantDb` runs at most `maxInFlight` transactions at once (default 8), each holding one pooled connection; further ones wait for a slot. A transaction body that calls the same helper again, directly or in work it starts, takes no second slot, so nesting can't deadlock. The limit is a constructor input; per-tenant overrides come with the operator limits.
- **Control data source.** `PgDatabase.Control` is a replica's separate two-connection pool for lease renewal, release and the fencing path ([grant renewal](./hosted-runtime.md#d-hosted-grant-renewal)). Tenant traffic never uses it, so neither the shared pool nor the statement cap can delay a renewal.

### D-hosted-tenant-tables

**User decision U5(a) (shared schema, `tenant_id`, RLS), with derived rules.** Every table in the schema is either one of the cluster tables or a tenant table. The cluster tables are `tenants`, `replicas`, `tenant_leases`, `schema_migrations`, `schema_info`, and P2's `tenant_hostnames`, `tenant_wakeups`, `provider_grants`, `operator_documents` and `operator_credentials` ([cluster tables](#d-hosted-cluster-tables)).

**A tenant table has:**
- a non-null `tenant_id integer` defaulting to `current_setting('foxwarm.tenant')`;
- a primary key, and every unique index, starting with `tenant_id`;
- `ENABLE` and `FORCE ROW LEVEL SECURITY`, with a policy (`USING` and `WITH CHECK`) on the current tenant;
- the fence trigger;
- the runtime role's grants.

Migrations create these by calling `foxwarm_tenant_table(table, privileges)` right after `CREATE TABLE`.

**Collation.** Every collatable column of every table uses `"C"`. Ordering and keyset paging then match the SQLite stores' byte order.

`SchemaLintTests` checks all of these on the migrated schema, using the catalog queries in `SchemaLint`.

**Roles.** The runtime role and the operator role are the roles named at the first migration, recorded in `schema_info` (`app_role`, `operator_role`). Both must exist before migrating and must differ; later migrations must name the same roles. A database migrated before the operator role existed records it at its next migration. The runtime role has DML only on tenant tables and isn't the table owner, so forced RLS applies to it. The operator role has no grant on tenant tables. The migrating role owns the schema. Migrations read the role names from the transaction settings `foxwarm.app_role` and `foxwarm.operator_role`.

### D-hosted-cluster-tables

**Plan §3.1 and §6.3 (P2), coordinator-confirmed.** Cluster tables have no row-level security. The runtime role only reads them, except the P1 writes the replicas need (registering in `replicas`, acquiring and renewing in `tenant_leases`), and it can't read `operator_credentials` at all. A compromised tenant runtime therefore can't change tenants, hostnames, grants or operator documents. The operator role owns those writes.

- **`tenants`.** `name` is the slug: the public identity, immutable (`foxwarm_tenant_slug_immutable`, SQLSTATE `FW002`), and a DNS label for tenants created from now on (the check is `NOT VALID`, so existing P1 names stay). `state` adds `deleting`. New columns: `profile` (`hosted`, `operator`), `pinned_role` (null or `master-host`), and the operator's `settings` and `limits` objects.
- **`replicas`.** `replica_id` stays the per-boot lease owner. `name` is the stable logical name it was made from (`ReplicaRegistry.LogicalName`), written at registration. New columns: `mesh_address`, `draining`, `capacity`; `role` is `general`, `master-host` or `operator`.
- **`tenant_leases`.** `draining_since` is the routing drain flag. It isn't part of `foxwarm_require_lease`, so a draining owner keeps writing and renewing. Acquisition and release clear it. `deletion_epoch` is the epoch a deletion took the row at.
- **`tenant_hostnames`** maps lowercase hostnames to tenants, with at most one `primary` per tenant; `custom` is for later custom domains.
- **`tenant_wakeups`** holds one row per tenant: `due_at`, the due `occurrence` carried through activation, and the failed-start backoff (`next_attempt_at`, `attempts`). The runtime role writes only its own row, under its current lease epoch, through `foxwarm_set_wakeup(due, occurrence)` (which also clears the backoff), `foxwarm_clear_wakeup()` and `foxwarm_wakeup_backoff(next_attempt, create)`. An activation never deletes the row ([generations](./hosted-runtime.md#d-hosted-generations)).
- **`provider_grants`, `operator_documents`, `operator_credentials`**: Provider grants with quotas, ceiling policies and profile overrides (global or per tenant), and operator token hashes.
- **Signals.** Statement triggers send `NOTIFY foxwarm_tenants` when hostnames or routing-relevant tenant columns change (not on a reader-version raise), and `NOTIFY foxwarm_operator` when operator documents or Provider grants change.
- **Reader floor.** Migration 0003 is expand-only (floor 1). It can't fence P1 binaries out, because their schema level (0701) is above any floor a 0003 migration may declare; the P1→P2 cutover is coordinated instead.

### D-hosted-schema-fence

**Derived from design §8.3.** Schema changes run only through `foxwarm db migrate`, never implicitly at replica start.

- **Migration files.** Each migration is an embedded `NNNN_<name>.sql` resource whose first line is `-- reader-floor: N`.
  - N is the lowest binary schema level that can still run against a database with this migration applied. Expand-only migrations keep the floor of the schema before them.
  - The binary's level is its highest migration version.
- **Applying.** The migrator applies missing versions in version order, each in its own transaction under `pg_advisory_xact_lock`. Version numbers are reserved per track and may merge out of order.
  - Each applied migration is recorded with its SHA-256 and reader floor.
  - A changed applied migration is refused.
  - Migrating also creates the named tenant and its released lease row when missing.
- **Replicas refuse to run** (`SchemaMigrator.RequireCompatibleAsync`, exit 78 at the entry; [replica lifecycle](./hosted-runtime.md#d-hosted-replica-lifecycle)) when any of these holds:
  - a migration of this build is missing;
  - an applied migration differs from this build's;
  - an applied migration unknown to this build has a reader floor above this build's level.

### D-hosted-bootstrap

**Derived.** Hosted settings come from environment variables, read before any store opens.

- **Variables.**
  - `FOXWARM_MODE` is `file` (the default) or `hosted`; any other value is an error.
  - `FOXWARM_TENANT` is the tenant name, default `default`.
  - `FOXWARM_APP_ROLE` is the runtime role for migrations, default `foxwarm_app`; `FOXWARM_OPERATOR_ROLE` the operator role, default `foxwarm_operator` (`db migrate --app-role`, `--operator-role`).
  - `FOXWARM_DATABASE_URL` is the runtime connection.
  - `FOXWARM_MIGRATE_DATABASE_URL` is the schema owner's connection; it falls back to the runtime URL.
- **Secrets.** The URLs also accept a `_FILE` form naming a mounted secret. Setting both forms is an error.
- **Connection strings** are Npgsql keyword strings or `postgres[ql]://` URLs.
- **Exit codes.** `foxwarm db migrate` and `foxwarm db status` exit 78 for bootstrap and schema refusals, and 2 for usage errors.

## Tests and fixtures

- **Fixture classes.** Hosted test classes carry `[Trait("Backend", "postgres")]`.
- **`PostgresServer`** starts one disposable cluster per test process, selected by one of two variables, both read only in the test assembly:
  - `FOXWARM_TEST_PG_PREFIX`: an extracted PGDG prefix. The fixture runs `initdb` under a short `/tmp` path with a Unix socket only, SCRAM authentication, durability settings off and a watcher that removes it when the test process ends.
  - `FOXWARM_TEST_PG_URL`: an existing server with a superuser.
- **`PostgresServer` setup.** It creates non-superuser owner, runtime and operator roles and migrates a template database once.
- **`HostedTestDatabase`** gives each test its own copy of the template.
- **`PgTcpProxy`** is a loopback proxy whose directions can be held or severed, which simulates partitions and lost `COMMIT` replies.
- **`S3Server`** (classes with `[Trait("Backend", "s3")]`) runs one VersityGW per process with its POSIX backend under a short `/tmp` path, root credentials passed through the environment, and an ephemeral loopback port. It is selected by `FOXWARM_TEST_VERSITYGW`, or by `FOXWARM_TEST_S3_URL` with its key variables; each test takes its own bucket name.
- **Runner and CI.**
  - Without its fixture, `scripts/test/run-tests.mjs managed` excludes `Backend=postgres` or `Backend=s3` and prints a "… batch not run" notice.
  - The CI job `managed-hosted` gets both servers through `acquire-hosted-fixtures.sh`, which downloads pinned packages with SHA-256 checks: PostgreSQL from the permanent PGDG archive, VersityGW from its release. It runs `--filter=Backend=postgres|Backend=s3|Backend=neutral`; the neutral rerun is in [hosted runtime](./hosted-runtime.md#tests).
- **What the tests cover.**
  - `TenantDbTests`: epoch fencing, expiry, trigger fencing of raw writes, RLS separation, takeover waiting for in-flight writers while renewal doesn't, lost-commit verification, retries, read-only reads, statement timeout, `Close`.
  - `SchemaMigratorTests`: idempotent and concurrent migration, the reader-floor fence, refusal of changed migrations and of a different runtime role.
  - `SchemaLintTests`: the lint rules on the real schema and on nonconforming examples; the cluster-table rules (no RLS, runtime role read-only except the listed writes) are part of the same lint.
  - `ClusterSchemaTests`: the runtime role can't write `tenants`, `tenant_hostnames`, wake-ups, grants or operator documents, or read credentials, while the operator role can and can't read tenant data; slug immutability and DNS labels; one primary hostname; the signals; the wake-up functions under the current lease only, kept through activation, backoff, clear; the lint on a nonconforming cluster table; recording and refusal of the operator role.
  - `HostedSourceRulesTests`: keeps Npgsql inside `Hosted/`, and connections and transactions inside `PgDatabase`, `TenantDb`, the migrator, the lease and the replica registry.

## Open Questions

- A cross-store unit of work over `TenantDb` (one transaction spanning several stores) has no P1 consumer (plan C2). Its sketch stays in the storage-context unit.
