# Unit: src-session-worker-runtime

Files: src/sessionWorkerStore.ts, src/sessionWorkerStoreSchema.ts, src/sessionWorkerStableJson.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerControlService.ts, src/sessionWorkerProcessIdentity.ts, src/sessionWorker.ts
Secondary files: src/sessionWorkerStore.test.ts, src/sessionWorkerSupervisor.test.ts, src/sessionWorkerStoreConcurrencyChild.ts, src/sessionWorkerCrashParent.ts, src/sessionWorkerHangingChild.ts

## Purpose

Provides the durable ownership/mailbox and supervised process-lifecycle foundation for future per-session workers. The foundation is intentionally not wired into production SessionRuntime placement yet: `sessionWorkers:true` continues to fail startup until the worker owns hydrated session state and the complete supported turn path.

## Key exports

- `SessionWorkerStore` — SQLite-backed generation/incarnation ownership, durable mailbox intents, head revision publication, cursor acknowledgement, activity, exit, and fail-closed reconciliation records.
- `SessionWorkerSupervisor` — one-child-per-session candidate activation, exact-process startup reconciliation, idle release, bounded drain/TERM/KILL, exit confirmation, and optional post-exit restart.
- `sessionWorkerControlServiceDescriptor` — minimal versioned candidate identity/activation/status control service used while the real session service is still being implemented.
- `readSessionWorkerProcessIdentity()` — Linux boot-ID plus proc start-tick identity used to distinguish an exact old process from PID reuse.
- `sessionWorker.ts` — child bootstrap for the control service.

## Durable records

`state/session-runtime.sqlite` contains:

- `session_worker_ownership`: one row per session with process generation, random incarnation, candidate/ready/draining lifecycle, PID plus process identity, activation time, authoritative head revision/path/hash, mailbox cursor, activity timestamp, and last exit reason;
- `session_worker_mailbox`: immutable idempotent input intents with per-session intent identity and the generation/revision that applied them.

A mailbox publication may acknowledge only one ordered pending prefix. The head revision CAS and mailbox acknowledgements commit in one SQLite transaction, so a crash cannot publish a snapshot while losing its input cursor or advance the cursor past an older unconsumed input. Mailbox payloads accept only strict JSON values and use stable object-key ordering; descriptor-only traversal prevents getters from executing, and invalid/cyclic/non-finite/sparse/accessor/non-plain values fail before a database write. Exact duplicate intent insertion is one database-level idempotent transaction across concurrent connections.

Schema open sets the busy timeout before lock-taking pragmas, migrates known version zero state inside `BEGIN IMMEDIATE`, records `user_version=1`, validates required column constraints, state checks, uniqueness, and partial-index semantics, and rejects unknown newer versions. Version-zero mailbox payloads are parsed through the strict validator and rewritten canonically inside the migration transaction; poison data rolls the whole migration back. A legacy inactive ownership row remains inactive, while any legacy noninactive row without a provable incarnation/process identity becomes an unproven retained fence instead of being cleared. Snapshot artifacts and production hydration remain a later integration step.

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
- Candidates cannot hydrate, process, touch activity, or publish before durable activation. Stale generations/incarnations cannot publish a head, acknowledge mailbox inputs, or replace a current owner.
- Invalid/reused mailbox intent identities fail closed; exact idempotent repeats return the original record.
- Draining generations may publish one final revision before confirmed exit.
- The supervisor never treats IPC disconnect alone as permission to replace a worker.
- This process boundary provides fault containment and throughput placement, not security isolation.

## Integration status

The store and supervisor currently have isolated real-child tests but are not initialized by `src/index.ts`. Worker-safe session persistence, router execution, event/reverse-service bridges, and SessionRuntime routing must land before `sessionWorkers:true` becomes functional.

## Canonical ownership

The cross-module placement, durability, fencing, idle, and future worker-owned session decisions are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).
