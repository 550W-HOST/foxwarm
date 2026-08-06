# Unit: src-session-worker-publication

Files: src/sessionWorkerPublicationService.ts, src/sessionWorkerPublication.ts
Secondary files: src/sessionWorkerHost.ts, src/sessionWorkerSupervisor.ts, src/sessionWorker.ts, src/sessionWorkerRuntimeTestChild.ts, src/sessionWorkerPublicationService.test.ts

## Purpose

Provides the fixed trusted-local reverse boundary and Main in-memory coordinator for awaited complete committed Session-worker state projections. It does not publish history bodies, mutate the Main Session catalog, or create a second durable authority.

## Key exports

- `sessionWorkerPublicationServiceDescriptor` — fixed `session-worker-publication@1.publishCommitted` method.
- `SessionWorkerProjectionRegistry` — current exact generation/incarnation registry with establish, awaited apply, cloned get/list, ordered subscribers, exact stale marking, and exact clear.
- `createSessionWorkerPublicationServiceHandler()` — exact identity-fenced, plain/bounded projection validator and apply handler.
- `initializeSessionWorkerPublication()` / `publishCommitted()` / `shutdownSessionWorkerPublication()` — local or borrowed-reverse client lifecycle.

## Boundary

A request contains only exact session/generation/incarnation identity plus the existing complete bounded `SessionWorkerProjection`. The projection has exact top-level keys, strict finite plain JSON, bounded strings and total size, runtime/state/stat counters, and no `stateRevision`, history, queue items, message bodies, callbacks, or live Session.

Main establishes an identity as stale before activation. A matching full publication replaces it with a cloned fresh projection and awaits subscribers in registration order. Subscriber failure marks that exact entry stale and fails acknowledgement. Older/mismatched identities cannot apply; stale marking and clear affect only the exact current owner. Registry state is process-local presentation/coordinator state only and never writes `sessions.json` or per-session authority.

WorkerHost publishes once after initial authoritative load before queue processing, after mailbox JSON-before-ack completion, and after each central authoritative persist used by busy, append, wait, settings, reminders, and exec completion. Publication failure is postcommit: it sets a distinct publication poison, does not restore the pre-write semantic snapshot, and prevents later mutation. A later attempted persistence reloads authoritative JSON to discard any uncommitted caller mutation, then still requires restart/full publication resync.

Supervisor disconnect/exit marks the exact entry stale. A replacement generation is established stale and becomes fresh only after its initial full authority publication. Main restart naturally begins with an empty registry.

## Tests

Coverage proves exact DTO/source/generation fencing, clone isolation, ordered callbacks, callback-failure staleness, no `stateRevision`, replacement generation full apply, postcommit failure without semantic rollback, later mutation resync/poison behavior, initial/busy/final/settings publications, and real forked reverse publication.

## Design Decisions

Committed projection and lifecycle resync semantics are canonical in [D-process-topology-session-events](../threads/process-topology-and-rpc.md#d-process-topology-session-events).
