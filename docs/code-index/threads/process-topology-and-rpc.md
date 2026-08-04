# Thread: process topology and RPC

## Overview

Foxwarm uses one logical set of asynchronous service contracts with configurable process placement. A service may run in the caller's process through a local handler or in a supervised child through IPC. Placement must not create a second business API or expose mutable in-process objects to callers.

The first production service on this boundary is the LanceDB/vector owner. Session workers remain disabled by default while the session runtime is prepared for a later high-level DTO boundary.

## Configuration

- `sessionWorkers` defaults off. It accepts `false`, `true`, or an object. Supplying an object enables the mode unless `enabled:false`; `idleSeconds` defaults to 60 and is bounded from 1 through 86,400 seconds.
- `dbWorkers` defaults on. In the current scope it controls only the LanceDB/vector owner. Archive and LLM-request-journal SQLite stores are not moved behind that worker.
- Both placement switches are read at startup. Saving configuration does not hot-migrate a live service between processes.

## Runtime boundary

Service descriptors define serializable request, response, error, and event DTOs. The registry binds each descriptor to either a local handler or a child-process transport. Both placements remain asynchronous and use the same validation and cloning boundary; local callers do not receive handler-owned object references.

Requests carry protocol/build identity, a process generation, request and trace IDs, and optional deadlines. Child shutdown first stops new requests, drains accepted work within a bound, and then exits. Replies from an obsolete process generation are rejected.

Large history, images, and tool output do not move through a central payload broker. Service calls use bounded DTOs and stable file/blob/snapshot references where necessary.

## Vector placement

The vector service owns the LanceDB connection/table, per-session indexing chains, batch state, startup backfill, embedding requests, searches, and vector lifecycle operations. It reads durable archive rows and vector checkpoints directly from the archive SQLite store. Archive durability and exact recall remain independent of vector availability.

With `dbWorkers:false`, the same vector service handler runs locally. With `dbWorkers:true`, a supervised child owns LanceDB and the main process never silently opens a second fallback owner after a worker failure.

## Session direction

A future session worker owns one session's hydrated hot state and turn loop. External callers use high-level commands, queries, and events rather than a remotely dereferenceable `Session` object. The in-process session runtime must adopt the same DTO contract before child placement is enabled broadly.

## Failure boundary

- Vector indexing is best-effort. A vector-worker failure does not roll back session, archive, or compact commits.
- Exact archive recall remains available without LanceDB. Semantic search reports a retryable unavailable error while the vector owner restarts.
- Process isolation is intended for fault containment and parallel throughput. It is not a security or sandbox boundary.
- SQLite locking protects database integrity but does not replace session-generation fencing for semantic ownership.

## Modules and units

- [infrastructure](../modules/infrastructure.md) / [src-index](../units/src-index.md) / [src-config](../units/src-config.md)
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

## Open questions

- The SessionRuntime DTO migration and durable inactive-session mailbox are later milestones; they are not implemented by the initial vector-worker foundation.
- Direct Unix-domain connections among future session, vector, and master-node services may replace the initial parent/child transport when avoiding a main-process payload hop becomes relevant.