# Unit: src-session-worker-publication

Files: src/sessionWorkerPublicationService.ts, src/sessionWorkerPublication.ts
Secondary files: src/sessionWorkerHost.ts, src/sessionWorkerSupervisor.ts, src/sessionWorker.ts, src/sessionWorkerRuntimeTestChild.ts, src/sessionWorkerPublicationService.test.ts

## Purpose

Provides the fixed trusted-local reverse boundary and Main in-memory coordinator for awaited complete committed Session-worker state projections. It does not publish history bodies, mutate the Main Session catalog, or create a second durable authority.

## Key exports

- `sessionWorkerPublicationServiceDescriptor` — fixed `session-worker-publication@2.publishCommitted` method.
- `SessionWorkerProjectionRegistry` — current exact generation/incarnation registry with establish, awaited apply, cloned get/list, ordered subscribers, exact stale marking, and exact clear.
- `createSessionWorkerPublicationServiceHandler()` — exact identity-fenced, plain/bounded projection validator and apply handler.
- `initializeSessionWorkerPublication()` / `publishCommitted()` / `shutdownSessionWorkerPublication()` — local or borrowed-reverse client lifecycle.

## Boundary

A request contains only exact session/generation/incarnation identity plus the existing complete bounded `SessionWorkerProjection`, including nullable raw current/child effort overrides. The projection has exact top-level keys, strict finite plain JSON, bounded strings and total size, strictly shaped current runtime active/tool/waiting records, matching duplicated busy/queue counters, and no `stateRevision`, history, queue items, message bodies, callbacks, or live Session.

Main establishes an identity as stale before activation. A matching full publication replaces it with a cloned fresh projection and awaits subscribers in registration order. Subscriber failure marks that exact entry stale and fails acknowledgement. Older/mismatched identities cannot apply; stale marking and clear affect only the exact current owner. Registry state is process-local presentation/coordinator state only and never writes `sessions.json` or per-session authority.

WorkerHost publishes once after initial authoritative load before queue processing, after a mailbox prefix actually advances the acknowledged cursor, and after each central authoritative persist used by busy, append, wait, settings, reminders, and exec completion. Empty mailbox checks do not republish. Presentation producers and the runtime-state boundary normalize tool argument previews to bounded strings before projection construction; Main keeps exact field validation rather than accepting arbitrary types. Publication failure is postcommit: it sets a distinct publication poison, does not restore the pre-write semantic snapshot, and prevents later mutation. One host-local pre-mutation fence reloads authoritative JSON and fails before later archive append, queue/system-event/exec completion, or mailbox side effects; persist hooks also use it to discard mutations made immediately before the hook. Restart/full publication resync remains required.

Supervisor disconnect/exit marks the exact entry stale. A replacement generation is established stale and becomes fresh only after its initial full authority publication. Main restart naturally begins with an empty registry.

The Main-local SessionRuntime may consume a projection only when the durable ownership row is noninactive and its generation/incarnation exactly matches the registry entry. It overlays committed Worker fields for list/state presentation and emits bounded existing state/list events without copying the projection into the Main Session or catalog. Explicit history remains an atomic authoritative JSON read, not a projection payload.

Model-stream drafts remain outside this committed publication contract. The runtime RPC exposes a separate exact-Worker transient snapshot read, while live version-2 deltas continue through the presentation channel only when subscribed.

## Tests

Coverage proves exact DTO/source/generation fencing, nested runtime validation and duplicated counter agreement, clone isolation, ordered callbacks, callback-failure staleness, no `stateRevision`, replacement generation full apply, postcommit failure without semantic rollback, malformed primitive tool arguments without publication poison, later same-Worker turn recovery, pre-archive/queue mutation fencing, empty-mailbox no-op behavior, initial/busy/final/settings publications, and real forked reverse publication.

## Design Decisions

Committed projection and lifecycle resync semantics are canonical in [D-process-topology-session-events](../threads/process-topology-and-rpc.md#d-process-topology-session-events).
