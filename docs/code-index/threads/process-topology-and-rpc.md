# Thread: process topology and RPC

## Overview

Foxwarm uses one logical set of asynchronous service contracts with configurable process placement. A service may run in the caller's process through a local handler or in a supervised child through IPC. Placement must not create a second business API or expose mutable in-process objects to callers.

The first child-process service on this boundary is the LanceDB/vector owner. SessionRuntime now has a production-used local DTO service for high-level session queries, enqueue/control, settings, and update events. Session child placement remains disabled while its supported vertical slice is implemented. The durable ownership/mailbox, supervised child-lifecycle, and save-before-ack per-session persistence seams now exist, but turn execution, reverse global services, and placement routing are not production-wired yet.

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

`SessionRuntime` is the external command/query/event boundary for session list/state/history projections, canonical queue insertion, typed events, stop/dequeue/retry controls, and persisted model/cwd/node/name/compact-threshold settings. Its local handler delegates to `sessionManager`, but local RPC cloning and structured errors prevent callers from retaining handler-owned `Session`, history, queue, or event references. WebUI list/state/history/settings/SSE, channel message enqueue, commands, and migrated tools use this boundary. The local `SessionTurnRunner` reached through MessageRouter still uses live objects and one non-RPC `LocalSessionTurnHost`; no Session-worker caller or serialized turn-host contract exists at this checkpoint.

`sessionWorkers:true` fails startup with `SESSION_WORKERS_NOT_IMPLEMENTED` rather than reporting an incomplete placement. `SessionWorkerStore` persists one generation/incarnation fence plus ordered strict-JSON mailbox intents in a versioned dedicated SQLite database. `SessionWorkerSupervisor` starts an inert candidate, durably registers its PID plus boot/start identity, durably activates the incarnation, and only then opens the child's activation gate. It retains ownership across IPC disconnect, releases idle children through bounded drain/termination, distinguishes PID reuse during startup reconciliation, and restarts only after exact-process exit observation. Unprovable identity, unconfirmed exit, or failed exit persistence retains the fence and fails closed; process termination continues even when lifecycle persistence fails. This foundation is not initialized by production bootstrap until the supported turn path is complete.

The existing `state/sessions/<id>.json` remains the single full semantic Session authority in both placements. Current payloads are explicitly `sessionStateVersion:1` and persist `lastAppliedMailboxId` with history, queue, wait/managed metadata, frontier, prompt/cache state, and settings. Unversioned legacy files receive one tolerant upgrade: only historically catalog-only stats/meta/vector fields are seeded from the catalog stub, file values win, and the complete v1 payload is durably rewritten before worker use. Current-version hydration exactly replaces the semantic field set; missing fields mean current defaults rather than stale catalog merge. Main-only pin/archive/sidebar/channel presentation state remains outside that replacement.

A worker applies only an ordered session-local mailbox prefix. The caller supplies a bounded count, while persistence reads canonical intent rows and payloads directly from SQLite before invoking apply. It durably replaces JSON through temp write, file fsync, rename, and directory fsync, and only then marks the prefix applied and advances SQLite's acknowledgement cursor. Global mailbox IDs may have gaps belonging to other sessions. On recovery, JSON cursor ahead of SQLite means the already-durable prefix is acknowledged without reapplying it; SQLite ahead of JSON is an impossible ordering violation and fails closed. Applied rows may be cleaned later only through the acknowledged cursor.

Workers write only the per-session file. Main remains the sole `sessions.json` catalog writer through the existing session-manager path; there is no dormant projection writer, catalog ownership coordinator, or release/handoff API. A small cloned projection DTO remains only as a possible input to the future real placement slice.

Catalog projection delivery and main-owned lifecycle handoff are deliberately deferred until the real MessageRouter/SessionRuntime worker vertical slice provides concrete callers. That future flow must be one closed supervisor-owned operation: block respawn, confirm worker exit, read/reconcile authoritative JSON itself, replace the main stub, perform and save the lifecycle mutation, then allow respawn. Generic callback claims and standalone release protocols are not supported contracts.

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

[2026-08-04] Main durably records an input before waking or spawning a session worker. One supervised process generation/incarnation owns one hot session. A fork begins as an inert candidate: main must durably register its PID plus boot/start identity and activate that exact incarnation before the child may hydrate or process. IPC disconnect alone does not release ownership, PID reuse is distinguished from the exact old process, and replacement cannot start until that process's exit is confirmed. A future main-owned lifecycle operation must keep respawn blocked across confirmed exit, authoritative reload, mutation, and save; its concrete closed flow is deferred to the real placement slice rather than exposed as a generic claim API.

### D-process-topology-session-state-authority

[2026-08-05] `state/sessions/<id>.json` remains the one full semantic Session authority for local and process placement; do not introduce immutable runtime-head artifacts or a second compatibility mirror. The file uses an explicit current format version and persists `lastAppliedMailboxId`; unversioned legacy data is upgraded once without discarding historically catalog-only state, while current-format hydration replaces rather than merges semantic fields. An owning worker must durably replace the complete JSON before SQLite can mark that exact ordered session-local mailbox prefix applied. JSON cursor ahead of SQLite is recovered by acknowledging without reapplication, including when global mailbox IDs contain gaps for other sessions; SQLite cursor ahead of JSON is impossible and fails closed. SQLite owns only generation/incarnation and mailbox coordination. Workers never write shared `sessions.json`; main remains its sole writer. Projection delivery and lifecycle handoff remain deferred until the concrete placement path exists.

### D-process-topology-session-events

[2026-08-04] Worker-to-main committed session events carry the owner generation plus a monotonic session state revision/cursor or an equivalent explicit gap/resync signal. Event backpressure may discard transient display progress, but it cannot silently lose committed history; main resynchronizes from the authoritative per-session JSON after a committed-event gap.

### D-process-topology-session-tool-placement

[2026-08-04, updated 2026-08-05] Provider requests, prompt serialization, the canonical turn loop, ToolScript, and ordinary safe session-local tools run in the owning worker. Tool placement uses exhaustive ownership metadata that is separate from permission policy and the model schema. The master node is the colocated execution environment, not the main management process: when `currentNode=master`, registered node-environment primitives execute directly in the owning session worker; a remote current node uses the existing main-owned authenticated node connection. The exact node-environment surface is canonical in [D-dispatch-node-environment-placement](./tool-dispatch.md#d-dispatch-node-environment-placement). Operations that depend on main-owned topology, channels, timers, node connections, or other global singleton state use a bounded reverse main-service call with a stable operation identity. Vector placement remains independent; an initial bounded query proxy may pass through main so long as it does not carry full history or prompt payloads. Active background exec processes prevent idle worker release until completion and its notification are durably handed back. Open browser tabs are ephemeral: graceful idle release closes process-local tabs and browser resources rather than keeping the worker alive.

## Open questions

- SessionRuntime child placement still needs turn-executor rehosting, worker-safe archive append fencing, reverse global services, committed-event resync, and production placement routing. The durable store/supervisor and authoritative JSON save-before-ack seams deliberately remain disconnected from production until that vertical slice is complete.
- Direct Unix-domain connections among future session, vector, and master-node services may replace the initial parent/child transport when avoiding a main-process payload hop becomes relevant.