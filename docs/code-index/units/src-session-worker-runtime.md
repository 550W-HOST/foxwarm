# Unit: src-session-worker-runtime

Files: src/sessionWorkerStore.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerControlService.ts, src/sessionWorker.ts
Secondary files: src/sessionWorkerStore.test.ts, src/sessionWorkerSupervisor.test.ts

## Purpose

Provides the durable ownership/mailbox and supervised process-lifecycle foundation for future per-session workers. The foundation is intentionally not wired into production SessionRuntime placement yet: `sessionWorkers:true` continues to fail startup until the worker owns hydrated session state and the complete supported turn path.

## Key exports

- `SessionWorkerStore` — SQLite-backed generation ownership, durable mailbox intents, head revision publication, cursor acknowledgement, activity, exit, and startup recovery.
- `SessionWorkerSupervisor` — one-child-per-session process ownership, readiness, idle release, bounded drain/TERM/KILL, exit confirmation, and optional post-exit restart.
- `sessionWorkerControlServiceDescriptor` — minimal versioned identity/status control service used while the real session service is still being implemented.
- `sessionWorker.ts` — child bootstrap for the control service.

## Durable records

`state/session-runtime.sqlite` contains:

- `session_worker_ownership`: one row per session with process generation, lifecycle state, PID, authoritative head revision/path/hash, mailbox cursor, activity timestamp, and last exit reason;
- `session_worker_mailbox`: immutable idempotent input intents with per-session intent identity and the generation/revision that applied them.

A mailbox publication may acknowledge only one ordered pending prefix. The head revision CAS and mailbox acknowledgements commit in one SQLite transaction, so a crash cannot publish a snapshot while losing its input cursor or advance the cursor past an older unconsumed input. Snapshot artifacts and production hydration are a later integration step.

## Lifecycle

- A new generation starts only from durable `inactive` state.
- Child readiness verifies session ID, generation, and PID before the store records `ready`.
- IPC disconnect removes readiness but retains ownership until process exit is observed.
- Idle or explicit release records `draining`, attempts RPC drain, then escalates through SIGTERM and SIGKILL within a bound.
- Replacement/restart is scheduled only after exit observation successfully returns ownership to `inactive`.
- Startup recovery clears orphaned process ownership while preserving generation, head, and mailbox state.

## Invariants

- At most one live generation is recorded for one session.
- Stale generations cannot touch activity, publish a head, acknowledge mailbox inputs, or replace a current owner.
- Invalid/reused mailbox intent identities fail closed; exact idempotent repeats return the original record.
- Draining generations may publish one final revision before confirmed exit.
- The supervisor never treats IPC disconnect alone as permission to replace a worker.
- This process boundary provides fault containment and throughput placement, not security isolation.

## Integration status

The store and supervisor currently have isolated real-child tests but are not initialized by `src/index.ts`. Worker-safe session persistence, router execution, event/reverse-service bridges, and SessionRuntime routing must land before `sessionWorkers:true` becomes functional.

## Canonical ownership

The cross-module placement, durability, fencing, idle, and future worker-owned session decisions are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).
