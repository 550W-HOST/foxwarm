# Unit: Hosted runtime (lease, self-fencing, standby, health)

Files: `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/Hosted/HostedReplica.cs`, `dotnet/Foxwarm/Hosted/Lease/TenantLease.cs`, `dotnet/Foxwarm/Hosted/Lease/LeaseMonitor.cs`, `dotnet/Foxwarm/Hosted/Lease/ReplicaRegistry.cs`, `dotnet/Foxwarm/Hosted/HealthEndpoint.cs`, `dotnet/Foxwarm/Hosted/StandbyForwarder.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Documents.cs`, `dotnet/Foxwarm/Hosted/Postgres/StateDocuments/PgStateDocuments.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0002_state_documents.sql`, `dotnet/Foxwarm/Hosted/Runtimes/TenantServer.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantLeaseTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedEndpointsTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedTestBackendTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedTestBackend.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedRuntimeHarness.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/TenantFront.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedRuntimesInProcessTests.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantServerTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedTenantServerTests.cs`, `dotnet/Foxwarm.Tests/Storage/StateDocumentsContractTests.cs`
Secondary files: `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/Hosted/HostedBootstrap.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `scripts/test/run-tests.mjs`, `.github/workflows/tests.yml`

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
  4. owner: the `LeaseMonitor` starts with the replica's `TenantDb` attached. Its fence clock starts at `LeaseGrant.AcquisitionStart`, a monotonic stamp taken before the acquiring transaction began, so no later than the database time the expiry counts from; the commit, the handover and anything else before the first renewal take from the same budget;
  5. the forwarder stops accepting and hands its listen socket, still open, to the runtime (`HostedRuntimeContext.PublicListener`), whose host adopts it instead of binding the port; connections arriving meanwhile queue in its backlog, and the forwarder's held and piped connections go on until the run ends;
  6. the runtime is created and started under supervision; `/readyz` turns 200 only after that.
- **Supervised start.** The factory gets a token cancelled by a stop or a fence, and production passes it on (the S3 probe included). The replica races the start against both rather than awaiting it, so a factory or `StartAsync` that ignores cancellation doesn't hold the run. A runtime returned after cancellation is disposed, not started.
  - **Fence during start:** health reports `fencing` from the fence on (`/livez` and `/readyz` 503); the start is given up and a returned runtime disposed, together within the drain bound; the run returns 75 with `FenceTimes` set.
  - **Stop during start:** `stopping`; the same bounded wait and disposal, then the lease is released and the run returns 0.
  - **Failed start:** a constructed runtime is disposed before the lease is released; 78 for `HostedStartupException`, else 1.
- **Takeover is today's startup on the new owner.** Nothing carries over in memory; the runtime reads its state from the tenant's stores.
- **Graceful stop** (SIGTERM, SIGINT): health reports `stopping`, not ready, from the stop on, so a stopping owner never reports `owner` again, before or after the release. The runtime drains while this replica still owns the lease, then the lease is released, so a standby is woken by the notification instead of waiting out the TTL. The host keeps accepting while the Sessions drain and stops just before the release; stopping it earlier would only widen the time without a reachable owner, and releasing earlier would fence the old owner's last writes. Stopping the host waits at most `HostedEntry.HttpShutdownTimeout` (2 s) for requests still in progress, then aborts them: the host default of 30 s let a single client that sent part of a request and stalled hold the release for a whole lease TTL, which is how a deleted Kubernetes owner pod used to hand over only at expiry. The replica logs the stop, the runtime's stop and the release with elapsed times. A standby's graceful stop reports `stopping` (not ready) before it closes its port, so new connections go to another replica, and waits up to the drain bound for the connections it holds or forwards to end; a connection still in the kernel backlog when the port closes is reset, only accepted ones are drained.
- **Fence:** the runtime is disposed, bounded by the drain bound (8 s in production, below TTL minus the fence deadline), and the process exits 75 even if work is still running. A fenced replica doesn't wait for its heartbeat or remove its `replicas` row: it may be cut off from the database, and the row is diagnostic only. `HostedReplica.FenceTimes` records the reason and, from the start of the last successful renewal, the time of the fence, of the runtime's stop and of the run's return. The orchestrator restarts it as a standby. A fence during runtime start also exits 75 within the drain bound (see supervised start).
- **Exit codes** (`HostedExit`): 0 stopped; 1 any other failure, including an unreachable database, which a restart may fix; 75 fenced; 78 configuration: bootstrap settings, schema fence, lease refusal for an older reader, refused database credentials, role or database (SQLSTATE class 28, 3D000), and a runtime refusal (`HostedStartupException`). A start failure that isn't a fence releases the lease.
- **Production runtime today** (`HostedEntry.CreateRuntimeAsync`) refuses with 78 while the build has missing stores. It never falls back to files. With the blob stores every store has its PostgreSQL implementation. Over a complete context it puts the blobs on the deployment's backend ([hosted blobs](./hosted-blobs.md#d-hosted-blob-backend)), then opens the tenant key ring and reads the tenant configuration documents with the deployment configuration ([hosted configuration](./hosted-config.md#hosted-runtime-wiring)). The runtime it will build is `MainHost` with the hosted context (`MainHostRuntime`); `MainHost.CreateAsync` and `SessionManager` take the context as a parameter, and null keeps the file stores.
- **Bootstrap additions:** `FOXWARM_REPLICA_ID` (replica name, else the host name), `FOXWARM_ADVERTISE_ADDRESS` (`host:port` the forwarder of a standby connects to), `FOXWARM_SCRATCH_DIR` (ephemeral local directory, default under the temporary directory). The public listener and the health port come from the deployment configuration, read before standing by ([split](./hosted-config.md#d-hosted-config-split)).

## D-hosted-standby-endpoints

**Approved plan C3 (2026-11-26).**

- **Health port.** A replica serves health on its own port. It's unauthenticated, reports no tenant data, and is a minimal HTTP/1.1 responder that's independent of the Main host, which a standby never builds.
  - `/livez`: 200 unless the replica is fencing.
  - `/readyz`: 200 for a standby, and for an owner whose runtime has started.
  - `/status`: role, replica, tenant, epoch, seconds since the last renewal, readiness.
- **Public port of a standby.** The standby serves it with `StandbyForwarder`. Each TCP connection is piped unchanged to the owner's advertised address.
  - **No reachable owner.** The connection is held, not closed: no owner, or one that refuses or doesn't answer (the old owner's host has stopped, the new one isn't listening yet), is retried every 200 ms with the owner re-read, for at most one lease TTL counted from its accept; then the connection is closed. Every wait of a held connection (the shared lookup, the connect, the retry delay) is capped by that deadline; the hold ends once a TCP connect succeeds, so a response the owner is slow to send isn't bounded by it. Nothing has been read from the connection, so a retry loses nothing. One owner lookup at a time, with its own 5 s bound, is shared by all waiting connections; no waiter's deadline cancels it.
  - **Not its own owner.** Until the handover, an owner address equal to the replica's own advertised address is a stale grant (a restarted replica keeps its address while its old grant is still valid) and counts as no owner, so the standby never pipes into its own listener.
  - **Admission.** At most 2048 connections are held or forwarded at once (an internal constant); beyond that an accepted connection is reset at once. An accept failure other than shutdown (for example no descriptor left) is logged and retried; the port keeps listening.
  - **Disposal.** Each connection attempt owns its socket until it is handed to the pump; after shutdown no new attempt starts, and disposal joins the forwarding tasks for at most 250 ms, so an exit after a fence isn't held by I/O that ignores cancellation.
  - **Why a byte pipe is enough.** Authentication, cookies and WebSocket upgrades happen at the owner, and Main reads no client address.
  - **Takeover.** The listen socket passes to the owner's host (`HttpServerSettings.ListenSocket`, adopted through Kestrel's `CreateBoundListenSocket` for the same port), so the port is never closed. Connections the forwarder holds reach the new owner, which is this replica. A runtime without HTTP closes the socket. What this buys is a graceful handover that loses no fresh connection: a request on a new connection, sent while no owner serves, is held or queued and served by the new owner. It doesn't migrate an established stream: bytes already piped to the old owner are never replayed, so an HTTP/2 or WebSocket connection to it ends, and a non-idempotent request it had read but not answered is lost. A crash failover still waits for the lease to expire, and a held connection gives up after a TTL.
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

## D-hosted-runtime-ownership

A runtime owns what its build started, so a retired or failed runtime releases it without the process exiting (P2 hosts several tenant runtimes per process).

- **The tenant context is disposable.** `PostgresStorageContext.DisposeAsync` stops the journal (writer loop and retention) and disposes the S3 client both S3 blob stores share. The tenant database isn't closed there; the lease owns it.
- **Who disposes it.** `HostedEntry.BuildRuntimeAsync` owns the context from its call: a build that fails (key ring refused, configuration invalid, host construction failed) disposes it before rethrowing, and `CreateRuntimeAsync` does the same when the blob backend refuses. A built runtime (`MainHostRuntime`) disposes it after its host.
- **Bounded after-effects.** A disposed runtime's `MainHost`, `SessionManager` and owners become unreachable within moments (about 150 ms measured, from disposal continuations and cancelled timers), and its threads and descriptors return to the baseline. `UsageOverview` cancels its pending change notice at disposal. Text-redaction detection queues belong to the installation's redactor, not to a process-wide map.

## D-hosted-tenant-server

`TenantServer` is the `IServer` of a tenant runtime that has no listener (`HttpServerSettings.Server`): a replica's front server receives every request and hands it to the tenant with `DispatchAsync`.

- **Own context, shared transport.** The tenant pipeline runs over a new feature collection that carries the front request's transport features (request, response and body, abort, upgrade and extended CONNECT, connection, size limit, trailers, reset, TLS, rates). Endpoint, route values, DI scope, items, user and the request caches (query, cookies, form) are the tenant context's own. Handing over the front's whole collection makes the tenant resolve the front's scoped services and reuse the endpoint the front's routing selected; with a front fallback route that re-enters the front without end.
- **Limits.** Kestrel limits configured inside a tenant app don't apply: the front's listener enforces the request size limit (2 MiB, as the Main server's listener), and tenant routes raise it per request as before.
- **Lifetime.** Tenant hosts use `HostControlledLifetime`, never the console lifetime: only the replica owns SIGTERM and SIGINT, and a tenant stops when the replica stops it.
- **Stop.** A stopping tenant refuses new dispatch before reading anything of the request (`DispatchAsync` returns false; the front answers). Requests in progress get the host's shutdown timeout, then are aborted through their own abort feature; other tenants' requests on the front aren't affected.
- **Addresses.** The server reports the front's address as the tenant's (`IServerAddressesFeature`), which the host's own URL consumers read.

## Tests

- **`TenantLeaseTests`** (`Backend=postgres`):
  - single ownership, and release waking a standby well before its poll;
  - expiry;
  - refusal for an older reader;
  - renewal keeping the lease across several TTLs;
  - fencing on takeover and on a refused write;
  - a partitioned owner fencing itself before a standby can acquire;
  - an owner cut off at once, its monitor started late, fencing at the deadline counted from the acquisition stamp, before the TTL;
  - a takeover not blocked by a partitioned owner's open transaction.
- **`HostedStartupTests`** (`Backend=postgres`) runs two in-process replicas of one tenant over one database, the runtime being `MainHost` over the test-only mixed context with the listener passed directly:
  - a standby forwards HTTP to the owner; after a graceful stop it takes over on the notification, well before the TTL, and serves the state the first owner wrote; requests on new connections to the standby's port every 50 ms throughout the handover all succeed;
  - a partitioned owner fences, stops within the drain bound and exits 75, and the standby acquires only after expiry, at a higher epoch. The bounds are checked on the owner's own `FenceTimes`, measured from its last successful renewal start, so test-thread scheduling doesn't move them: fence at or after the deadline, return before the TTL, takeover at least a TTL after that renewal;
  - with runtimes the tests gate (`HostedStartupTests.Lifecycle.cs`): a fence during a factory that ignores cancellation reports `fencing` at once and exits 75 within the drain bound, and the late runtime is never started; a fence during `StartAsync` disposes the runtime; a stop during the factory or the start exits 0, disposing the runtime while the lease is still held; a failed start disposes it before the release and frees the port; a draining standby fails `/readyz` while its port refuses and a forwarded connection still works; `/status` sampled over HTTP across an owner's graceful stop reports `stopping` and not ready from within 200 ms of the stop, and never `owner` after the standby took over; a connection held by the standby and one queued on the handed-over port, each with its whole request and EOF sent at once, are served once the gated start completes;
  - on the production runtime builder, a client that sent part of a request and stalls holds a graceful stop only for the HTTP shutdown timeout, then the lease is released;
  - refusal for an older reader and for a too-new schema (78);
  - refused credentials exit 78, an unreachable database exits 1;
  - the production runtime builds a context with no missing store; without key-encryption keys it refuses (78), releases the lease and leaves the scratch directory empty.
- **`HostedEndpointsTests`** covers health responses per role and the byte-exact forwarder in both directions. It also checks, with explicit barriers: four simultaneous held connections, requests and EOF sent before any owner exists, share one stalled lookup and get their exact echo once the owner listens; the hold counts from the accept while a lookup stalls, and the owner found late gets no connection; disposal during a stalled lookup leaves no socket when the lookup completes; a standby doesn't forward to its own address before the handover and does after it; connections beyond the admission limit are reset at once; a handed-over port keeps queueing and a held connection reaches the new owner on it; that draining closes the port while a forwarded connection finishes; and that stopping the forwarder closes connections and frees the port.
- **`StateDocumentsContractTests`** runs the portable document cases on the file and Postgres stores. The Postgres subclass adds the reader-version mirror and a fenced replacement that leaves the previous text.
- **The test backend** (`HostedTestBackend`). `FOXWARM_TEST_BACKEND=postgres`, read only in the test assembly, sets the internal `SessionManager.StorageForTests` seam.
  - **What it builds.** Every manager constructed without a context or file-store hooks gets a Postgres context with one database per data root. Stores not yet implemented come from files; only tests ever build such a mixed context. Authority, Archive and Identities are one group: while any of them is missing, all three come from files, because the file Authority writes the SQLite Archive directly and an identity move rewrites all three. Its key ring uses a key-encryption key generated per test process. A root's pool lives for the test process, because nothing says when a root is done, so its idle connections close after 2 s instead of Npgsql's default 300 s; otherwise a serial run keeps a few idle connections for every root so far and exhausts the fixture's `max_connections` (200).
  - **Which classes run on it.** Classes qualified for both backends carry `[Trait("Backend", "neutral")]`. With a PostgreSQL fixture, `run-tests.mjs managed` runs the selected neutral classes a second time this way (`dotnet-hosted-neutral`). Each store track qualifies its own classes.
- **Several runtimes in one process (P2 foundation).** `HostedRuntimesInProcessTests` uses `HostedRuntimeHarness` (production `BuildRuntimeAsync` over one database, a model peer that keeps nothing): one console capture for twelve runtimes; twenty build, load and dispose cycles end within 4 MiB of the first; a retired runtime (its `MainHost`, `SessionManager` and a large owner) becomes unreachable and its threads and descriptors return to the baseline while a survivor keeps serving; a build refused by the key ring stops the journal writer it started. `TenantServerTests` puts two bare tenant apps behind `TenantFront` (a Kestrel front with its own scoped service and fallback route): own scope and endpoint, unknown host, size limit and its per-route raise, server-sent events, compression, WebSocket upgrade with the tenant's close status, client abort, and stop with refusal and abort after the shutdown timeout. `HostedTenantServerTests` does the same with the production runtime: per-host credentials and data, compression, Session event stream, upload, the WebUI socket (no logs topic), inbound MCP initialize and stream, and a retired tenant refused while the other serves.
