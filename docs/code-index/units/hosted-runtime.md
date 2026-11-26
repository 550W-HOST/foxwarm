# Unit: Hosted runtime (lease, self-fencing, standby, health)

Files: `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/Hosted/HostedReplica.cs`, `dotnet/Foxwarm/Hosted/Lease/TenantLease.cs`, `dotnet/Foxwarm/Hosted/Lease/LeaseMonitor.cs`, `dotnet/Foxwarm/Hosted/Lease/ReplicaRegistry.cs`, `dotnet/Foxwarm/Hosted/HealthEndpoint.cs`, `dotnet/Foxwarm/Hosted/StandbyForwarder.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Documents.cs`, `dotnet/Foxwarm/Hosted/Postgres/StateDocuments/PgStateDocuments.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0002_state_documents.sql`, `dotnet/Foxwarm.Tests/Hosted/TenantLeaseTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedEndpointsTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedTestBackendTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedTestBackend.cs`, `dotnet/Foxwarm.Tests/Storage/StateDocumentsContractTests.cs`
Secondary files: `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/Hosted/HostedBootstrap.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `scripts/test/run-tests.mjs`, `.github/workflows/tests.yml`

## Purpose

A hosted tenant has one owner replica at a time, and any number of standbys. This unit owns how a replica gets, keeps and loses that ownership, and what a standby does while it waits. It also owns the tenant's storage context, whose stores are added by the store tracks.

The write fence that makes a lost lease harmless is in [hosted database](./hosted-database.md#d-hosted-write-fence). The image, the Compose and Helm deployments and the drills that exercise these contracts are in [hosted packaging](./hosted-packaging.md).

## D-hosted-lease

**User decision U17 (TTL 30 s, renew 5 s, self-fence at 20 s), with derived mechanics.**

- **Acquire** (`TenantLease.TryAcquireAsync`). The lease can be taken when it's released, expired or already this replica's, the tenant is `active`, and the tenant's `min_reader_version` is at most this binary's installation reader level.
  - **Refusals.** A tenant marked for a newer reader throws `LeaseRefusedException`; that's a permanent refusal, not "held".
  - **Order of steps.** The replica checks first without a lock. That matters: a waiting `FOR UPDATE` would queue the owner's writers. Only then does it select the lease row `FOR UPDATE` under a `lock_timeout`, which waits for in-flight writers of the old epoch.
  - **Raising the epoch.** It rechecks, then raises `epoch`, sets the owner, `active` and `expires_at = now() + TTL`.
  - All times are database times.
- **Renew** (`RenewAsync`) is a plain update of `expires_at`. It matches only this owner and epoch, `active` and still unexpired. Zero rows means the lease is lost.
- **Release** (`ReleaseAsync`) sets `released` and `expires_at = now()`, then sends `NOTIFY foxwarm_lease`. An old grant changes nothing.
- **Import** (`TryAcquireForImportAsync`, `ActivateImportAsync`) is the migrating role's lease for [hosted import](./hosted-import.md#d-hosted-import): it creates an `importing` tenant or takes an empty one with a free lease, raising the epoch, and activation sets the tenant `active` and releases the lease in one transaction.
- **Standby.** `AcquireAsync` keeps a `LISTEN foxwarm_lease` connection. It retries every renew interval and right after a notification, so a graceful handover takes about a second instead of waiting out the TTL.
- **Replica IDs** (`ReplicaRegistry.NewReplicaId`) are the configured name (`FOXWARM_REPLICA_ID`, else the host name) plus a random suffix per process start. A restarted process therefore never resumes an earlier grant.
- **Replica rows.** `replicas` rows record the advertised address, binary schema level and reader level. They're routing and diagnostic data only; ownership is decided by the lease alone.

## D-hosted-self-fence

**Derived from U17.** `LeaseMonitor` renews every renew interval and fences the runtime in three cases:

- a renewal finds the lease taken over, released or expired;
- a write is refused by the epoch fence (`TenantDb.Fenced`);
- no renewal has succeeded within the fence deadline.

**The deadline is measured from the *start* of the last successful renewal**, on the local monotonic clock. That start is no later than the server time the renewal used, and the deadline is below the TTL, so the owner always stops before the lease can expire.

**The deadline is watched by its own timer.** It doesn't depend on a renewal call returning. Each renewal wait is also bounded by its attempt deadline, even if the client ignores cancellation on a dead network path. A partition test caught that blocking case.

**Fencing does three things:**
- it closes every attached `TenantDb`, so later transactions are refused locally;
- it cancels `Lost`;
- it completes `Fenced` with the reason.

The hosted entry then shuts the runtime down and exits (hosted startup, batch 3).

**What bounds a takeover.** The server ends a partitioned owner's open transaction on its own, through the transaction-local `statement_timeout` (15 s) and `idle_in_transaction_session_timeout` (10 s) set by `TenantDb`. A takeover after expiry is therefore not blocked by that transaction's lease lock.

## D-hosted-replica-lifecycle

**Derived from the approved plan (§3, §11.3 batch 3, 2026-11-26).**

- **Entry.** `FOXWARM_MODE` selects the shape: unset, empty or `file` is today's entry; `hosted` runs `HostedEntry`; anything else exits 2. A build without hosted mode reports that and exits 2. The hosted entry takes no data directory and no installation lock: the tenant lease is the single-owner guarantee.
- **Order** (`HostedReplica.RunAsync`):
  1. schema fence (`RequireCompatibleAsync`);
  2. tenant lookup and replica registration, then a heartbeat every renew interval;
  3. standby: health reports `standby`, the forwarder serves the public endpoint, `AcquireAsync` waits;
  4. the forwarder is disposed before the runtime is built, which frees the public port for the owner's host;
  5. owner: the `LeaseMonitor` starts with the replica's `TenantDb` attached, then the runtime is created and started; `/readyz` turns 200 only after that.
- **Takeover is today's startup on the new owner.** Nothing carries over in memory; the runtime reads its state from the tenant's stores.
- **Graceful stop** (SIGTERM, SIGINT): the runtime drains while this replica still owns the lease, then the lease is released, so a standby is woken by the notification instead of waiting out the TTL.
- **Fence:** the runtime is disposed, bounded by the drain bound (8 s in production, below TTL minus the fence deadline), and the process exits 75 even if work is still running. A fenced replica doesn't wait for its heartbeat or remove its `replicas` row: it may be cut off from the database, and the row is diagnostic only. `HostedReplica.FenceTimes` records the reason and, from the start of the last successful renewal, the time of the fence, of the runtime's stop and of the run's return. The orchestrator restarts it as a standby. A fence during runtime start also exits 75.
- **Exit codes** (`HostedExit`): 0 stopped; 1 any other failure, including an unreachable database, which a restart may fix; 75 fenced; 78 configuration: bootstrap settings, schema fence, lease refusal for an older reader, refused database credentials, role or database (SQLSTATE class 28, 3D000), and a runtime refusal (`HostedStartupException`). A start failure that isn't a fence releases the lease.
- **Production runtime today** (`HostedEntry.CreateRuntimeAsync`) refuses with 78 while the build has missing stores. It never falls back to files. With the blob stores every store has its PostgreSQL implementation. Over a complete context it puts the blobs on the deployment's backend ([hosted blobs](./hosted-blobs.md#d-hosted-blob-backend)), then opens the tenant key ring and reads the tenant configuration documents with the deployment configuration ([hosted configuration](./hosted-config.md#hosted-runtime-wiring)). The runtime it will build is `MainHost` with the hosted context (`MainHostRuntime`); `MainHost.CreateAsync` and `SessionManager` take the context as a parameter, and null keeps the file stores.
- **Bootstrap additions:** `FOXWARM_REPLICA_ID` (replica name, else the host name), `FOXWARM_ADVERTISE_ADDRESS` (`host:port` the forwarder of a standby connects to), `FOXWARM_SCRATCH_DIR` (ephemeral local directory, default under the temporary directory). The public listener and the health port come from the deployment configuration, read before standing by ([split](./hosted-config.md#d-hosted-config-split)).

## D-hosted-standby-endpoints

**Approved plan C3 (2026-11-26).**

- **Health port.** A replica serves health on its own port. It's unauthenticated, reports no tenant data, and is a minimal HTTP/1.1 responder that's independent of the Main host, which a standby never builds.
  - `/livez`: 200 unless the replica is fencing.
  - `/readyz`: 200 for a standby, and for an owner whose runtime has started.
  - `/status`: role, replica, tenant, epoch, seconds since the last renewal, readiness.
- **Public port of a standby.** The standby serves it with `StandbyForwarder`. Each TCP connection is piped unchanged to the owner's advertised address. Without an owner, the connection is closed.
  - **Why a byte pipe is enough.** Authentication, cookies and WebSocket upgrades happen at the owner, and Main reads no client address.
  - **Takeover.** Disposing the forwarder closes its connections and frees the port for the host.
- **Why the standby reports ready.** It keeps Kubernetes rolling updates working: a new pod becomes Ready as a standby before an old owner stops. P2's request forwarder replaces the passthrough.

## D-hosted-storage-context

**Derived from the approved plan (2026-11-26).**

- **Shape.** `PostgresStorageContext` holds one `TenantDb` for the tenant at the replica's epoch, plus the replica's scratch directory.
- **Partial-file pattern.** Each store is created by a `Create…` partial method that the store's track implements in its own `PostgresStorageContext.<Store>.cs`. Wiring a store never edits the foundation file. The authority is created last, so it can use the Archive and blob stores.
- **Missing stores.** A store without an implementation stays missing: `Missing` names it, and its property throws `NotSupportedException`. Hosted startup refuses a context with missing stores.
- **State documents** (`PgStateDocuments`, migration 0002) are the reference store:
  - **Storage.** One `state_documents` row per closed document name, with the text verbatim and a generation.
  - **Replacement.** A replacement is one fenced upsert. A lost `COMMIT` is resolved by checking for the written generation and text.
  - **What file mode's extras turn into.** Absence is "no row". `ReadFirstAvailable` reads the current version only: retained backups exist for torn files, and a transactional replace can't tear. `EnsureDurable` is a no-op.
  - **Installation document.** Writing it raises `tenants.min_reader_version` in the same transaction through `foxwarm_raise_reader_version`, which checks the lease and never lowers the value.
- **Session catalog** (`PgSessionCatalog`, migration 0200): [hosted catalog](./hosted-session-catalog.md).

## Tests

- **`TenantLeaseTests`** (`Backend=postgres`):
  - single ownership, and release waking a standby well before its poll;
  - expiry;
  - refusal for an older reader;
  - renewal keeping the lease across several TTLs;
  - fencing on takeover and on a refused write;
  - a partitioned owner fencing itself before a standby can acquire;
  - a takeover not blocked by a partitioned owner's open transaction.
- **`HostedStartupTests`** (`Backend=postgres`) runs two in-process replicas of one tenant over one database, the runtime being `MainHost` over the test-only mixed context with the listener passed directly:
  - a standby forwards HTTP to the owner; after a graceful stop it takes over on the notification, well before the TTL, and serves the state the first owner wrote;
  - a partitioned owner fences, stops within the drain bound and exits 75, and the standby acquires only after expiry, at a higher epoch. The bounds are checked on the owner's own `FenceTimes`, measured from its last successful renewal start, so test-thread scheduling doesn't move them: fence at or after the deadline, return before the TTL, takeover at least a TTL after that renewal;
  - refusal for an older reader and for a too-new schema (78);
  - refused credentials exit 78, an unreachable database exits 1;
  - the production runtime builds a context with no missing store; without key-encryption keys it refuses (78), releases the lease and leaves the scratch directory empty.
- **`HostedEndpointsTests`** covers health responses per role and the byte-exact forwarder in both directions. It also checks that a forwarder without an owner closes the connection, and that stopping the forwarder closes connections and frees the port.
- **`StateDocumentsContractTests`** runs the portable document cases on the file and Postgres stores. The Postgres subclass adds the reader-version mirror and a fenced replacement that leaves the previous text.
- **The test backend** (`HostedTestBackend`). `FOXWARM_TEST_BACKEND=postgres`, read only in the test assembly, sets the internal `SessionManager.StorageForTests` seam.
  - **What it builds.** Every manager constructed without a context or file-store hooks gets a Postgres context with one database per data root. Stores not yet implemented come from files; only tests ever build such a mixed context. Authority, Archive and Identities are one group: while any of them is missing, all three come from files, because the file Authority writes the SQLite Archive directly and an identity move rewrites all three. Its key ring uses a key-encryption key generated per test process. A root's pool lives for the test process, because nothing says when a root is done, so its idle connections close after 2 s instead of Npgsql's default 300 s; otherwise a serial run keeps a few idle connections for every root so far and exhausts the fixture's `max_connections` (200).
  - **Which classes run on it.** Classes qualified for both backends carry `[Trait("Backend", "neutral")]`. With a PostgreSQL fixture, `run-tests.mjs managed` runs the selected neutral classes a second time this way (`dotnet-hosted-neutral`). Each store track qualifies its own classes.
