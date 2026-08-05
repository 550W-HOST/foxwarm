# Unit: src-session-worker-runtime

Files: src/sessionWorkerStore.ts, src/sessionWorkerStoreSchema.ts, src/sessionWorkerStableJson.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerPersistence.ts, src/sessionWorkerCatalog.ts, src/sessionWorkerControlService.ts, src/sessionWorkerProcessIdentity.ts, src/sessionWorker.ts
Secondary files: src/sessionWorkerStore.test.ts, src/sessionWorkerSupervisor.test.ts, src/sessionWorkerPersistence.test.ts, src/sessionWorkerStoreConcurrencyChild.ts, src/sessionWorkerCrashParent.ts, src/sessionWorkerHangingChild.ts, src/sessionWorkerStateFileChild.ts

## Purpose

Provides durable ownership/mailbox coordination, save-before-ack authoritative state persistence, bounded catalog projection, main lifecycle quiescing, and supervised process lifecycle for future per-session workers. The seams are intentionally not wired into production SessionRuntime placement yet: `sessionWorkers:true` continues to fail startup until the complete supported turn path exists.

## Key exports

- `SessionWorkerStore` — SQLite-backed generation/incarnation ownership, durable mailbox intents, acknowledgement cursor, activity, exit, cleanup, and fail-closed cursor reconciliation.
- `SessionWorkerSupervisor` — one-child-per-session candidate activation, exact-process startup reconciliation, idle release, bounded drain/TERM/KILL, exit confirmation, and optional post-exit restart.
- `SessionWorkerPersistence` — authoritative JSON load/apply/save-before-ack recovery, bounded catalog projection, and quiesce/reload/main-mutation seams.
- `writeSessionWorkerCatalogProjection()` — main-only atomic merge of bounded worker projection that preserves topology/UI fields and removes stale full queue/wait/managed state from the catalog record.
- `sessionWorkerControlServiceDescriptor` — minimal versioned candidate identity/activation/status control service used while the real session service is still being implemented.
- `readSessionWorkerProcessIdentity()` — Linux boot-ID plus proc start-tick identity used to distinguish an exact old process from PID reuse.
- `sessionWorker.ts` — child bootstrap for the control service.

## Durable records

`state/session-runtime.sqlite` contains:

- `session_worker_ownership`: one row per session with process generation, random incarnation, candidate/ready/draining lifecycle, PID plus process identity, activation time, acknowledged mailbox cursor, activity timestamp, and last exit reason;
- `session_worker_mailbox`: immutable idempotent input intents with per-session intent identity and optional applied generation/incarnation/time audit fields.

`state/sessions/<id>.json` is the sole full semantic authority and carries `lastAppliedMailboxId`. The worker applies only the exact ordered pending prefix for that session, durably replaces the complete JSON, then marks rows applied and advances SQLite's cursor in one transaction. Numeric gaps for globally allocated IDs belonging to other sessions are valid. Recovery acknowledges `JSON > SQLite` without reapplying and rejects `SQLite > JSON`; applied-row deletion is a later bounded operation limited by the acknowledged cursor. Mailbox payloads accept only strict JSON values and use stable object-key ordering; descriptor-only traversal prevents getters from executing, and invalid/cyclic/non-finite/sparse/accessor/non-plain values fail before a database write. Exact duplicate intent insertion is one database-level idempotent transaction across concurrent connections.

Schema open sets the busy timeout before lock-taking pragmas, migrates known version zero/one state inside `BEGIN IMMEDIATE`, records `user_version=2`, validates exact columns, state-dependent ownership and mailbox-application constraints, uniqueness/partial-index semantics, canonical strict-JSON payload rows, and cursor/application row ordering, and rejects unknown newer versions. Version zero/one payloads are strictly canonicalized inside the rollback-safe migration; version one head columns are intentionally removed because semantic state remains in per-session JSON. A legacy inactive ownership row remains inactive, while any legacy noninactive row without provable process identity becomes an unproven retained fence.

## Lifecycle

- A new random incarnation starts as a durable inert `candidate` only from `inactive` state. The child exposes only activation control and cannot run active methods yet.
- Main verifies session ID, generation, incarnation, PID, boot identity, and proc start ticks; it durably registers the candidate and marks it activated before asking the child to verify that exact row and open its activation gate.
- Main establishes provisional ownership and exit/error/disconnect tracking immediately after `fork()`, before process-identity reads or RPC transport construction. Any post-fork startup failure must confirm that exact `ChildProcess` exit before an unregistered candidate can be cleared; unconfirmed exit retains the candidate fence and a supervisor lifecycle failure. A main crash before registration leaves an inert candidate that cannot activate, while registered candidates and activated owners retain exact process identity for startup reconciliation.
- IPC disconnect removes readiness but retains ownership until process exit is observed.
- Idle or explicit release records `draining`, attempts RPC drain, then escalates through SIGTERM and SIGKILL within a bound.
- Replacement/restart is scheduled only after exit observation successfully returns ownership to `inactive`.
- Startup reconciliation compares boot/start identity before signaling an old PID, never signals a reused PID, and clears the fence only after the exact incarnation is proven gone. Unreadable/unprovable identity or unconfirmed exit retains the fence and fails startup placement.
- Drain/exit database failures never skip process termination. Stop reports lifecycle persistence failure after real exit; shutdown terminates every tracked PID concurrently, aggregates errors, and leaves any unrecorded fence intact.

## Invariants

- At most one activated generation/incarnation is recorded for one session.
- Candidates cannot hydrate, process, touch activity, or acknowledge mailbox inputs before durable activation. Stale generations/incarnations cannot advance the mailbox cursor or replace a current owner.
- SQLite acknowledgement can never advance before the authoritative JSON cursor; a main lifecycle claim blocks worker respawn across quiesce, reload, mutation, and save.
- Invalid/reused mailbox intent identities fail closed; exact idempotent repeats return the original record.
- Draining generations may publish one final revision before confirmed exit.
- The supervisor never treats IPC disconnect alone as permission to replace a worker.
- This process boundary provides fault containment and throughput placement, not security isolation.

## Integration status

The store, persistence coordinator, and supervisor have isolated real-child/crash-boundary tests but are not initialized by `src/index.ts`. Router execution, archive append fencing, event/reverse-service bridges, and SessionRuntime routing must land before `sessionWorkers:true` becomes functional.

## Canonical ownership

The cross-module placement, durability, fencing, idle, and future worker-owned session decisions are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).
