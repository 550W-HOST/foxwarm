# Unit: Hosted runtime (lease, self-fencing and health)

Files: `dotnet/Foxwarm/Hosted/HostedEntry.cs`, `dotnet/Foxwarm/Hosted/HostedRuntime.cs`, `dotnet/Foxwarm/Hosted/Lease/TenantLease.cs`, `dotnet/Foxwarm/Hosted/Lease/LeaseMonitor.cs`, `dotnet/Foxwarm/Hosted/Lease/GrantRenewer.cs`, `dotnet/Foxwarm/Hosted/Runtimes/FenceSupervisor.cs`, `dotnet/Foxwarm.Tests/Hosted/GrantRenewalTests.cs`, `dotnet/Foxwarm/Hosted/Lease/ReplicaRegistry.cs`, `dotnet/Foxwarm/Hosted/HealthEndpoint.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Documents.cs`, `dotnet/Foxwarm/Hosted/Postgres/StateDocuments/PgStateDocuments.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0002_state_documents.sql`, `dotnet/Foxwarm/Hosted/Runtimes/TenantServer.cs`, `dotnet/Foxwarm/Hosted/Runtimes/TenantGeneration.cs`, `dotnet/Foxwarm/Hosted/Runtimes/AdmissionGate.cs`, `dotnet/Foxwarm/Hosted/Runtimes/TenantActivations.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantActivationsTests.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantLeaseTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedTestBackendTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedStartupTests.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedTestBackend.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/HostedRuntimeHarness.cs`, `dotnet/Foxwarm.Tests/Hosted/Fixtures/TenantFront.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedRuntimesInProcessTests.cs`, `dotnet/Foxwarm.Tests/Hosted/TenantServerTests.cs`, `dotnet/Foxwarm.Tests/Hosted/HostedTenantServerTests.cs`, `dotnet/Foxwarm.Tests/Storage/StateDocumentsContractTests.cs`
Secondary files: `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/Hosted/HostedBootstrap.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `scripts/test/run-tests.mjs`, `.github/workflows/tests.yml`

## Purpose

Each tenant has one owner at a time. A replica can serve several tenants and forward requests for others. This unit owns the tenant grant, generation, fence and storage context.

Placement and the multi-tenant runtimes host are in [hosted runtimes host](./hosted-runtimes-host.md). The write fence that makes a lost lease harmless is in [hosted database](./hosted-database.md#d-hosted-write-fence). The image, the Compose and Helm deployments and the drills that exercise these contracts are in [hosted packaging](./hosted-packaging.md).

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

`LeaseMonitor` protects the import lease. Runtime generations use [`GrantRenewer`](#d-hosted-grant-renewal) and [supervised fencing](#d-hosted-supervised-fence); a confirmed per-tenant fence allows other tenants to continue.

**What bounds a takeover.** The server ends a partitioned owner's open transaction on its own, through the transaction-local `statement_timeout` (15 s) and `idle_in_transaction_session_timeout` (10 s) set by `TenantDb`. A takeover after expiry is therefore not blocked by that transaction's lease lock.

## D-hosted-replica-lifecycle

`FOXWARM_MODE=hosted` selects `HostedEntry`; it validates bootstrap, KEK and blob settings and starts `TenantReplica`. An incompatible cluster schema or bootstrap setting is exit 78. The [runtimes host](./hosted-runtimes-host.md#d-hosted-runtimes-host) registers one boot, opens a private authenticated mesh, starts its public front, and activates a compatible generation on demand. A failed tenant activation does not require restarting the replica. The tenant runtime has a `TenantServer` and no listening socket of its own.

`SIGTERM` withdraws readiness, closes admission to new generations, settles active tenants concurrently and hands back confirmed grants. The front stops last. An incomplete request that has not reached tenant admission cannot keep the tenant lease active. Exit 0 means confirmed shutdown; 75 means unconfirmed stop or fencing escalation. Other startup failures, including transient database connectivity, return 1. See [placement and shutdown](./hosted-forwarding.md#d-hosted-placement-requests) for deadlines and retry semantics.

## Health and public endpoints

The independent health port reports `/livez`, `/readyz` and `/status` (boot ID, role, state and published tenant count). A healthy boot can receive public requests before any tenant is resident. A healthy administratively drained boot remains ready; a stopping one is unready. All public requests use [hostname routing and exact dispatch](./hosted-forwarding.md#d-hosted-request-routing). There is no raw TCP handover between roles.

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

## D-hosted-grant-renewal

**Plan §3.2 (P2), coordinator-confirmed.** `GrantRenewer` keeps every grant a replica's tenant runtimes hold. A `GrantHandle` is one grant `(tenant, epoch)` with a deadline: the start of its last positive proof plus `FenceAfter`, on the monotonic clock. The grant is current until that deadline or until it is lost; a lost handle is never current again.

- **Proof and loss.** Both are decided under the handle's lock against the clock read inside it. A proof (`Prove`) moves the deadline forward only, and fails once the deadline has passed or the grant is lost, so a reply that arrives late, or a paused publisher, never extends it. The loss (`TryLose`) is decided once and records its instant: the time of the decision, or the deadline when that came first. Hard stops count from that instant, never from when a handler ran. The loss hooks run inline on the deciding thread and must only latch and close. A release (`TryRelease`, via `Untrack`) ends the grant without running them.
- **Batches.** Every renew interval, one round takes an immutable batch of the current handles together with a stamp from before its transaction. One statement (`TenantLease.RenewBatchAsync`), sent with its lock timeout as one implicit transaction in one round trip, renews each row under P1's predicate (owner, epoch, `active`, unexpired) and only while the tenant is `active`. Every time check uses `clock_timestamp()`, and the update rechecks the predicate on the row it locked, so a row that expired while the statement waited to be sent or for its lock is never renewed. The new expiry is `greatest(expires_at, clock_timestamp() + TTL)`: an older renewal that commits after a newer one can't move it back. Outcomes are published only after the commit, and only to that batch's handles. A grant tracked after the stamp isn't in the batch and keeps its own acquisition stamp until a round proves it. A loss of epoch e never touches e+1: the outcome belongs to the handle, not the tenant.
- **Contention.** Candidates are locked `FOR NO KEY UPDATE SKIP LOCKED`, which doesn't conflict with writers' `FOR KEY SHARE`. A row another transaction holds (a takeover's `FOR UPDATE`) is skipped and *unproved*; so is every row of a batch that hits its lock timeout (55P03). Each unproved row is retried alone on a single retry lane, waiting for the lock at most until its own deadline or one renew interval, until that deadline. A retry checks, on the lane and just before it starts, that its grant is still tracked and current: a grant lost while its retry waited is never renewed again. A row that no longer matches is lost at once.
- **Data sources.** The periodic batch has a connection of its own (`PgDatabase.Renewal`, one connection) that nothing else uses. Retries, acquisitions, wake-up reads and releases share the control source (`PgDatabase.Control`, two connections); P2 releases wait for row locks at most `TenantLease.LockTimeout` (one renew interval) and leave the grant to expire otherwise. Neither tenant transactions, which use the shared pool under their [statement cap](./hosted-database.md#d-hosted-write-fence), nor control traffic waiting on locks can delay a renewal. P1's single-tenant replica keeps its one shared source.
- **Watchdog.** A dedicated thread sleeps until the earliest deadline, or until a new grant arrives, and loses every handle whose deadline has passed, at that deadline, however late it runs. It doesn't depend on the thread pool. Holding no grants starts no countdown.
- **Losses.** `Lose` (a refused write, a takeover, the watchdog, an unconfirmed stop) and `LoseAll` (a replica-wide decision that the database is unreachable) decide losses. They never extend a grant. Their log lines are queued, never awaited.

## D-hosted-supervised-fence

**Plan §2.3 (P2), coordinator-confirmed.** `FenceSupervisor` bounds how long a replica waits for a fenced or failed runtime to stop.

- **Obligations.** Every stop the supervisor watches is an `Obligation`: a stop result and a hard stop. For a tenant generation the hard stop is its grant's `HardStop`: the loss instant, or while the grant is current its deadline, plus `DrainBound` (`FenceAfter + DrainBound < TTL` is checked). It is armed when the generation is registered, before anything is built, so the process ends at the latest at the grant's deadline plus the drain bound even if no loss handler ever runs. P1's fences use a fixed hard stop counted from the fence instant the lease monitor latched.
- **One decision.** One dedicated thread decides every obligation once. A stop is confirmed only by a `StopResult` that is confirmed and whose own timestamp, taken as the stop completed, is before the hard stop; an overdue confirmation never wins. Anything else ends the process with exit code 75 at the hard stop, directly: nothing synchronous runs ahead of the exit (the log line is queued, best effort), and it doesn't wait for other tenants' drains, releases or the pool's disposal.
- **Confirmation** means the settlement of everything the generation started. For a published generation: its release steps if any, a disposal that completed successfully, and then the end of all admitted work. For a build: a factory that refused cleanly, or a built runtime disposed cleanly. A fault, a cancellation or a `StartupCleanupFailedException` (a start whose own cleanup failed) never confirms.
- **No clean release after an unconfirmed stop.** Its grant is lost and never released; its row expires, or the next acquisition raises the epoch. The tenant stays unavailable on this replica until the process exits.
- **Suspension.** A process that is suspended past a hard stop exits as soon as it runs again. While it is suspended nothing in it runs; only the lease's SQL epoch fence protects commits, and a successor can't acquire before the TTL.
- **Runtimes.** A generation's runtime attaches its `TenantDb` to `ActivationContext.Fence`. A refused write (FW001) on it loses exactly that generation's grant.

## D-hosted-generations

**Plan §2.3 (P2), coordinator-confirmed.** `TenantActivations` owns a replica's tenant runtimes. Each runtime is one generation, `GenerationId(tenant, epoch, number)`, where the number counts this replica's generations of the tenant. Fences, callbacks and disposal name an exact generation: a late fence of a retired generation, or of an older epoch, never lands on its replacement.

- **Coalesced activation.** All activations of one tenant share one acquire, build, start and publish: front and mesh requests, wake-ups and recovery scans (`ActivationCause`). A waiter's cancellation ends only its own wait.
- **No self re-acquisition.** A grant this replica holds is reused by the next generation, never acquired again. `TryAcquireAsync` also takes a lease whose owner is this replica and raises its epoch, which would fence the replica's own runtime. The coordinator calls it only when it holds no live grant for the tenant.
- **Registration.** A generation is registered under its grant before its wake-up row is read or its runtime built; the loss hook and the supervisor see it from then on. A loss before the factory returns fences the build: the runtime it returns is disposed without `StartAsync`.
- **Publication.** A runtime is published, and its gate opens, only after its start completed while its grant was still current: its `GrantHandle` neither lost nor past its deadline, and the generation not fenced. A build that finishes later is disposed and the activation fails with `TenantFencedException`. Holding the lease isn't serving. An activation never returns a published generation whose grant is past its deadline; it decides the loss instead.
- **Fences.** A lost grant's hook latches and closes every generation under it inline (published, retiring or building) and retires them off the deciding thread. `FenceAsync` and `FenceGrantAsync` decide a loss and wait for the supervisor's decision.
- **Retirement.** Each slot keeps its retiring generation (fenced, idle-released, shut down). A new activation of the tenant waits for that retirement: a confirmed stop clears it, an unconfirmed one keeps the tenant unavailable here (`TenantFencedException`) until the process exits. Each disposal runs off the caller's thread.
- **Failed starts** dispose what was built and, when that cleanup is confirmed and the grant wasn't lost meanwhile, release it with a backoff (`ReleaseAfterFailedStartAsync`). The wake-up row records the backoff, and an autonomous activation (wake-up or recovery) creates a row if there was none. At shutdown the grant is released plainly instead. A start whose cleanup isn't confirmed releases nothing.
- **Admission gate.** `AdmissionGate` admits each unit of work and closes once, for idle release, drain, fence or stop. Every admission also checks the generation's grant against its deadline, so admission never depends on a loss handler having run. Admission and the idle check share one lock, so an idle latch can't race an admission, and a latched gate never reopens.
- **Producer admission (2026-11-28, coordinator decision).** Scheduled producers may enter the same gate while a current grant is building, as well as after publication. Requests require publication. A latch refuses both, and a producer holds its admission through its delivery and completion save, updating the idle clock on exit. A generation that fails construction or never publishes cancels its producer work and drains it before confirming its stop or releasing its grant. See [scheduled unload and restart](./hosted-channels-timers.md#scheduled-unload-and-restart).
- **Idle release** (`TryReleaseIdleAsync`), in order:
  1. Latch the gate if nothing is admitted, no admission happened within the idle time, and the runtime's own check holds.
  2. Stop producers.
  3. Settle in-flight deliveries. In a hosted Main, stop its services and streams and drain the accepted Session writers and final saves while holding the lease.
  4. Compute the next due time from the settled state while tenant storage is available. See [scheduled unload and restart](./hosted-channels-timers.md#scheduled-unload-and-restart) for a failed deadline read or stale startup.
  5. Finish disposing the runtime and drain remaining generation admissions.
  6. Write the wake-up row and release the lease in one transaction at the expected epoch (`ReleaseWithWakeupAsync`). A null due time clears the row.

  Work refused by the latched gate becomes demand (`AdmitAsync`). Demand that arrives before the transaction aborts the release: the grant stays, and the waiting activation builds the next generation over it at the same epoch. Steps 2–5 get the drain bound: a release that overruns it loses its grant unreleased (`IdleReleaseOutcome.Overrun`), the supervised fence cancels the steps and joins them, and the process ends if they don't confirm. A tenant is never latched and unavailable while its grant renews.
- **Shutdown** (`ShutdownAsync`, one absolute bound, `ShutdownBound`): every generation is latched and every retirement starts at once, off the caller's thread. Each tenant's grant is released as soon as its own stop is confirmed, without waiting for the others. At the bound, every tenant whose stop isn't confirmed loses its grant unreleased, and the result is false.
- **Wake-up carry-through.** The activation reads the tenant's wake-up row and passes it to the runtime (`ActivationContext.Wakeup`), so the due occurrence fires even when it is already past. A reconciled runtime acknowledges the row after publication; an unarmed or stale build preserves it.
- **Hosted shutdown ordering.** A retiring runtime cancels future long polls and gives admitted channel handlers a bounded interval to finish Session admission and checkpointing before closing Session mutations. At the deadline it closes further checkpoints and proceeds with the existing ingress fence. A blocked store stop still follows the generation's unconfirmed-stop rules. File mode retains its original shutdown order: a rejected event leaves the checkpoint for the next boot.
- **Production composition.** The [runtimes host](./hosted-runtimes-host.md) wires the front, producers, renewer and supervisor. [Scheduled unload and restart](./hosted-channels-timers.md) describes the sources and retry of the hand-back.

## D-hosted-tenant-server

`TenantServer` is the `IServer` of a tenant runtime that has no listener (`HttpServerSettings.Server`): a replica's front server receives every request and hands it to the tenant with `DispatchAsync`.

- **Own context, shared transport.** The tenant pipeline runs over a new feature collection that carries the front request's transport features (request, response and body, abort, upgrade and extended CONNECT, connection, size limit, trailers, reset, TLS, rates). Endpoint, route values, DI scope, items, user and the request caches (query, cookies, form) are the tenant context's own. Handing over the front's whole collection makes the tenant resolve the front's scoped services and reuse the endpoint the front's routing selected; with a front fallback route that re-enters the front without end.
- **Limits.** Kestrel limits configured inside a tenant app don't apply: the front's listener enforces the request size limit (2 MiB, as the Main server's listener), and tenant routes raise it per request as before.
- **Lifetime.** Tenant hosts use `HostControlledLifetime`, never the console lifetime: only the replica owns SIGTERM and SIGINT, and a tenant stops when the replica stops it.
- **Stop.** A stopping tenant refuses new dispatch before reading anything of the request (`DispatchAsync` returns false; the front answers). Requests in progress get the host's shutdown timeout, then are aborted through their own abort feature; other tenants' requests on the front aren't affected.
- **Addresses.** The server reports the front's address as the tenant's (`IServerAddressesFeature`), which the host's own URL consumers read.

## Tests

- **`TenantLeaseTests`** (`Backend=postgres`):
  - single ownership, hand-back and refusal of a superseded grant;
  - expiry;
  - refusal for an older reader;
  - renewal keeping the lease across several TTLs;
  - fencing on takeover and on a refused write;
  - a partitioned owner fencing itself before a standby can acquire;
  - an owner cut off at once, its monitor started late, fencing at the deadline counted from the acquisition stamp, before the TTL;
  - a takeover not blocked by a partitioned owner's open transaction.
- **`HostedStartupTests`** exercises setup, keys, profiles, the import path, journal and egress over real tenant generations. `TenantReplicaTests`, `ReplicaProcessTests` and `PlacementWaveProcessTests` exercise admission, shutdown, fencing, autonomous recovery and rolling replacement at the current public and mesh listeners.
- **`StateDocumentsContractTests`** runs the portable document cases on the file and Postgres stores. The Postgres subclass adds the reader-version mirror and a fenced replacement that leaves the previous text.
- **The test backend** (`HostedTestBackend`). `FOXWARM_TEST_BACKEND=postgres`, read only in the test assembly, sets the internal `SessionManager.StorageForTests` seam.
  - **What it builds.** Every manager constructed without a context or file-store hooks gets a Postgres context with one database per data root. Stores not yet implemented come from files; only tests ever build such a mixed context. Authority, Archive and Identities are one group: while any of them is missing, all three come from files, because the file Authority writes the SQLite Archive directly and an identity move rewrites all three. Its key ring uses a key-encryption key generated per test process. A root's pool lives for the test process, because nothing says when a root is done, so its idle connections close after 2 s instead of Npgsql's default 300 s; otherwise a serial run keeps a few idle connections for every root so far and exhausts the fixture's `max_connections` (200).
  - **Which classes run on it.** Classes qualified for both backends carry `[Trait("Backend", "neutral")]`. With a PostgreSQL fixture, `run-tests.mjs managed` runs the selected neutral classes a second time this way (`dotnet-hosted-neutral`). Each store track qualifies its own classes.
- **Several runtimes in one process (P2 foundation).** `HostedRuntimesInProcessTests` uses `HostedRuntimeHarness` (production `BuildRuntimeAsync` over one database, a model peer that keeps nothing): one console capture for twelve runtimes; twenty build, load and dispose cycles end within 4 MiB of the first; a retired runtime (its `MainHost`, `SessionManager` and a large owner) becomes unreachable and its threads and descriptors return to the baseline while a survivor keeps serving; a build refused by the key ring stops the journal writer it started. Hosted CI runs this class in its own testhost so the process-wide resource baselines do not include other classes' background work. A descriptor-bound failure reports the additional open targets and their counts. `TenantServerTests` puts two bare tenant apps behind `TenantFront` (a Kestrel front with its own scoped service and fallback route): own scope and endpoint, unknown host, size limit and its per-route raise, server-sent events, compression, WebSocket upgrade with the tenant's close status, client abort, and stop with refusal and abort after the shutdown timeout. `HostedTenantServerTests` does the same with the production runtime: per-host credentials and data, compression, Session event stream, upload, the WebUI socket (no logs topic), inbound MCP initialize and stream, and a retired tenant refused while the other serves.
- **Generations (P2).** `TenantActivationsTests` drives runtimes of its own over real lease rows and covers:
  - a gated simultaneous local request, mesh-style request and wake-up give one epoch increment and one start, while a waiter that gives up doesn't cancel them;
  - a late activation joins the live generation without re-acquiring;
  - late fences don't land on the replacement;
  - a build finishing after its grant was lost is disposed;
  - a failed start releases with a backoff;
  - idle release: its busy cases, step order and wake-up write, the occurrence carried into the next activation, and an abort by demand that keeps the grant for the next generation;
  - coordinator disposal.

  - placement at acquisition: the runtime is built for the profile the acquisition checked even when it changes before the build, and a general replica refuses an operator tenant without touching its lease.

  `AdmissionGateTests` races admissions against the idle latch.
- **Renewal (P2).** `GrantRenewalTests`, on real lease rows:
  - one batch over a live, an expired, a released, a taken-over and a suspended row renews only the live one, leaves the others untouched and loses exactly their handles;
  - a `FOR UPDATE` lock held on A's row past A's deadline fences A at it while B keeps renewing and making fenced commits, and A's row is never extended;
  - a database-wide partition of the control source fences every grant before the TTL, and the held commits delivered after healing revive none;
  - a grant keeps its acquisition stamp, and holding no grants starts no countdown;
  - `LoseAll` extends nothing;
  - a renewal that runs after its row expired inside its open transaction revives nothing, and an older renewal never moves a newer expiry back (both orderings, with a pause between `BEGIN` and the statement);
  - two releases waiting behind row locks hold both control connections while another tenant's renewal still completes at once; a release gives up at its lock timeout;
  - a retry queued for the lane is dropped when its grant is lost meanwhile;
  - the statement cap counts physical transactions with a pool no larger than the cap: a lookup from inside a body joins it, a second transaction is refused, work left running after the body takes its own slot, and renewal proceeds while the tenant holds the pool; a lost commit is verified after its slot was handed to a waiting transaction.
- **Supervised fences (P2).** `TenantActivationsTests` fences:
  - a gated start, while another tenant serves;
  - a start whose cancellation callback stalls, ending at the deadline while the other tenant serves;
  - an overrunning disposal, with the deadline counted from the fence;
  - a fence during graceful shutdown, which exits without waiting for the other tenant's drain;
  - a failed stop, unconfirmed with an empty gate, which releases nothing, exits at its hard stop and leaves the tenant unavailable;
  - a stop confirmed only once admitted work ended;
  - an idle release whose stop failed, which releases nothing and doesn't re-acquire;
  - demand during a fenced generation's disposal, which waits for its confirmed stop instead of acquiring;
  - a loss inside the factory, whose late build is disposed and never started;
  - a failed start whose cleanup failed, and a factory reporting `StartupCleanupFailedException`, both unconfirmed;
  - an expired grant that admits nothing and whose pre-armed hard stop ends the process with no loss handler run; a published generation past its deadline not returned to an activation;
  - an idle release bounded and handed to the fence, and one whose steps ignore cancellation, exiting at the bound plus the drain bound;
  - a shutdown where a synchronous stall in one tenant's disposal doesn't delay the release of a healthy sibling, and the stuck tenant loses its grant unreleased at the bound.

  `FenceSupervisorTests` covers the grant clock (late proofs, the loss instant), an exit that waits for no blocked logger, confirmation judged by its own timestamp, and a hard stop moved back by a loss. `HostedStartupTests` covers a fence during the single-tenant replica's graceful drain, a cancelled graceful disposal (unconfirmed, nothing released, exit at the drain bound) and a start whose cleanup failed.
