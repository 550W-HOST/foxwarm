# Thread: process topology and RPC

## Overview

Foxwarm uses one logical set of asynchronous service contracts with configurable process placement. A service may run in the caller's process through a local handler or in a supervised child through IPC. Placement must not create a second business API or expose mutable in-process objects to callers.

The first child-process service on this boundary is the LanceDB/vector owner. SessionRuntime now has a production-used local DTO service for high-level session queries, enqueue/control, settings, and update events. Session child placement remains disabled while its supported vertical slice is implemented. The durable ownership/mailbox and supervised child-lifecycle foundation now exists, but worker-safe snapshot persistence, turn execution, reverse global services, and placement routing are not production-wired yet.

## Configuration

- `sessionWorkers` defaults off. It accepts `false`, `true`, or an object. Supplying an object enables the mode unless `enabled:false`; `idleSeconds` defaults to 60 and is bounded from 1 through 86,400 seconds.
- `dbWorkers` defaults on. In the current scope it controls only the LanceDB/vector owner. Archive and LLM-request-journal SQLite stores are not moved behind that worker.
- Both placement switches are read at startup. Saving configuration does not hot-migrate a live service between processes.

## Runtime boundary

Service descriptors define serializable request, response, error, and event DTOs. The registry binds each descriptor to either a local handler or a child-process transport. Both placements remain asynchronous and use the same validation and cloning boundary; local callers do not receive handler-owned object references.

The initial process transport uses Node's parent/child IPC channel. Its transport/service separation leaves direct Unix-domain endpoints as a later topology change without changing service DTOs.

Requests carry protocol/build identity, a process generation, request and trace IDs, and optional deadlines. Child shutdown first stops new requests, drains accepted work within a bound, and then exits. Replies from an obsolete process generation are rejected.

The hot turn loop does not move full history, images, or tool output through a central payload broker. Explicit external history/debug reads may return the requested immutable snapshot; high-frequency service calls otherwise use bounded DTOs and stable file/blob/snapshot references where necessary.

## Vector placement

The vector service owns the LanceDB connection/table, per-session indexing chains, batch state, startup backfill, embedding requests, searches, and vector lifecycle operations. It reads durable archive rows and vector checkpoints directly from the archive SQLite store. Archive durability and exact recall remain independent of vector availability.

With `dbWorkers:false`, the same vector service handler runs locally. With `dbWorkers:true`, a supervised child owns LanceDB and the main process never silently opens a second fallback owner after a worker failure.

The production bootstrap completes authoritative session/archive migrations before starting the selected vector owner. Child readiness means LanceDB is open; startup backfill remains asynchronous. The native LanceDB module is loaded lazily only by the selected owner. Unexpected child exit or IPC disconnect makes semantic calls retryably unavailable. A bounded-backoff watchdog starts a new generation only after the prior PID's exit is observed. Graceful shutdown drains accepted calls and active indexing/backfill work before closing LanceDB; if needed, it escalates through SIGTERM and SIGKILL while retaining ownership until exit confirmation.

## Session direction

`SessionRuntime` is the external command/query/event boundary for session list/state/history projections, canonical queue insertion, typed events, stop/dequeue/retry controls, and persisted model/cwd/node/name/compact-threshold settings. Its local handler delegates to `sessionManager`, but local RPC cloning and structured errors prevent callers from retaining handler-owned `Session`, history, queue, or event references. WebUI list/state/history/settings/SSE, channel message enqueue, commands, and migrated tools use this boundary; the router's claimed turn loop and destructive lifecycle operations still use live objects internally.

`sessionWorkers:true` fails startup with `SESSION_WORKERS_NOT_IMPLEMENTED` rather than reporting an incomplete placement. `SessionWorkerStore` now persists one generation owner, ordered mailbox intents, an authoritative head revision/path/hash, and an atomically acknowledged mailbox cursor in a dedicated SQLite database. `SessionWorkerSupervisor` verifies child identity/readiness, retains ownership across IPC disconnect, releases idle children through bounded drain/termination, and restarts only after exit observation. This foundation is not initialized by production bootstrap until worker-safe snapshots and the supported turn path are complete.

A session worker will own hydrated state and the turn loop. Main-owned inputs first commit as immutable mailbox intents and only then wake or spawn the owner. A worker head publication advances one generation-fenced revision and acknowledges only an ordered pending mailbox prefix in the same transaction. Immutable snapshot artifacts, catalog projection, archive generation guards, and production hydration remain the next integration layer.

## Failure boundary

- Vector indexing is best-effort. A vector-worker failure does not roll back session, archive, or compact commits.
- Deterministic block rows are replaced before append, making retry after a Lance-commit/checkpoint gap idempotent.
- Exact archive recall remains available without LanceDB. Semantic search reports a retryable unavailable error while the vector owner restarts.
- Process isolation is intended for fault containment and parallel throughput. It is not a security or sandbox boundary.
- SQLite locking protects database integrity but does not replace session-generation fencing for semantic ownership.

## Modules and units

- [infrastructure](../modules/infrastructure.md) / [src-index](../units/src-index.md) / [src-config](../units/src-config.md)
- [src-rpc](../units/src-rpc.md)
- [src-session-runtime](../units/src-session-runtime.md)
- [src-session-worker-runtime](../units/src-session-worker-runtime.md)
- [session context](../modules/session-context.md) / [src-vector](../units/src-vector.md)
- [session core](../modules/session-core.md) / [message routing](../modules/message-routing.md)
- [tool dispatch](./tool-dispatch.md) and [node communication](./node-communication.md) for future direct service endpoints

## Design Decisions

### D-process-topology-configurable-placement

[2026-08-04] Keep one implementation-facing async service contract for local and child-process placement. `sessionWorkers` defaults off and accepts a boolean or object; object presence enables it with defaults unless `enabled:false`, and its idle release is configurable. `dbWorkers` defaults on and in its first version means only the LanceDB/vector owner. Placement changes are startup-only and may use graceful drain before replacement rather than supporting mixed-version live migration.

### D-process-topology-goals

[2026-08-04] Optional workers target fault containment and parallel throughput, with on-demand session resource release. They do not claim security isolation. Session workers may hold provider credentials and connect directly to providers; simple session-local tool steps should remain inside the session worker when possible.

### D-process-topology-worker-owned-session

[2026-08-04] A future session worker owns its session's hydrated state and high-frequency turn work instead of routing full history serialization through the main process. Persisted waits and ToolScript snapshots count as idle. The initial release has no fixed maximum worker count, while leaving room for a later spawn-time resource check.

### D-process-topology-session-generation

[2026-08-04] Main durably records an input before waking or spawning a session worker. One supervised process generation owns one hot session and is the only generation allowed to publish its semantic state. Snapshot-head revision and ordered mailbox-prefix acknowledgement commit together; stale generations and out-of-order acknowledgements fail closed. IPC disconnect alone does not release ownership, and replacement cannot start until the old PID's exit is confirmed. Main-owned lifecycle mutations quiesce the owner and reload its authoritative head before mutation.

### D-process-topology-session-events

[2026-08-04] Worker-to-main committed session events carry the owner generation plus a monotonic session revision or an equivalent explicit gap/resync signal. Event backpressure may discard transient display progress, but it cannot silently lose committed history; main resynchronizes from the authoritative head after a committed-event gap.

### D-process-topology-session-tool-placement

[2026-08-04] Provider requests, prompt serialization, the canonical turn loop, ToolScript, and ordinary safe session-local tools run in the owning worker. Operations that depend on main-owned topology, channels, timers, node connections, or other global singleton state use a bounded reverse main-service call with a stable operation identity. Vector placement remains independent; an initial bounded query proxy may pass through main so long as it does not carry full history or prompt payloads.

## Open questions

- SessionRuntime child placement still needs immutable snapshot artifacts and hydration, worker-safe archive/session persistence, catalog projection, turn-executor rehosting, reverse global services, committed-event resync, and production placement routing. The durable store/supervisor foundation deliberately remains disconnected from production until that vertical slice is complete.
- Direct Unix-domain connections among future session, vector, and master-node services may replace the initial parent/child transport when avoiding a main-process payload hop becomes relevant.