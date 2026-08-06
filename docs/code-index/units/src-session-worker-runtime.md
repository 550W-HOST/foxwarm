# Unit: src-session-worker-runtime

Files: src/sessionWorkerStore.ts, src/sessionWorkerStoreSchema.ts, src/sessionWorkerStableJson.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerPersistence.ts, src/sessionWorkerControlService.ts, src/sessionWorkerRuntimeService.ts, src/sessionWorkerHost.ts, src/sessionWorkerProcessIdentity.ts, src/sessionWorker.ts
Secondary files: src/sessionWorkerStore.test.ts, src/sessionWorkerSupervisor.test.ts, src/sessionWorkerPersistence.test.ts, src/sessionWorkerHost.test.ts, src/sessionWorkerToolPlacement.test.ts, src/sessionWorkerRuntimeTestChild.ts, src/sessionWorkerStoreConcurrencyChild.ts, src/sessionWorkerCrashParent.ts, src/sessionWorkerHangingChild.ts, src/sessionWorkerStateFileChild.ts

## Purpose

Provides durable ownership/mailbox coordination, save-before-ack authoritative state persistence, a pure bounded projection DTO, supervised process lifecycle, and the first activated child caller of the canonical SessionTurnRunner. The child host is intentionally not routed from production SessionRuntime yet: `sessionWorkers:true` continues to fail startup until the complete supported tool/reverse/publication/delivery path exists.

## Key exports

- `SessionWorkerStore` — SQLite-backed generation/incarnation ownership, durable mailbox intents, acknowledgement cursor, activity, exit, cleanup, and fail-closed cursor reconciliation.
- `SessionWorkerSupervisor` — one-child-per-session candidate activation, exact-process startup reconciliation, idle release, bounded drain/TERM/KILL, exit confirmation, and optional post-exit restart.
- `SessionWorkerPersistence` — versioned authoritative JSON replace/legacy upgrade plus canonical pending-prefix apply/save-before-ack recovery; callers choose only a bounded count and cannot supply intent payload rows.
- `SessionWorkerPersistence.persistActivated()` / `reloadActivated()` — generation/incarnation-verified complete turn-state save without advancing the mailbox cursor, plus exact-owner resync from authoritative JSON after a failed run.
- `buildSessionWorkerProjection()` — pure cloned bounded DTO builder with no catalog writer or ownership protocol.
- `sessionWorkerControlServiceDescriptor` — minimal versioned candidate identity/activation/status control service used while the real session service is still being implemented.
- `SessionWorkerHost` / `sessionWorkerRuntimeServiceDescriptor` — one process-lifetime exact owner, canonical runner, worker-local effects/ExecRuntime, and activated `runPending({limit})` method returning only the bounded projection.
- `readSessionWorkerProcessIdentity()` — Linux boot-ID plus proc start-tick identity used to distinguish an exact old process from PID reuse.
- `sessionWorker.ts` — child bootstrap for the shared-gate control and runtime services.

## Durable records

`state/session-runtime.sqlite` contains:

- `session_worker_ownership`: one row per session with process generation, random incarnation, candidate/ready/draining lifecycle, PID plus process identity, activation time, acknowledged mailbox cursor, activity timestamp, and last exit reason;
- `session_worker_mailbox`: immutable idempotent input intents with per-session intent identity and optional applied generation/incarnation/time audit fields.

`state/sessions/<id>.json` is the sole full semantic authority and carries `sessionStateVersion:1` plus `lastAppliedMailboxId`. Unversioned files are seeded once from historically catalog-only stats/meta/vector fields and rewritten; current v1 files exactly replace semantic state and cannot inherit stale stub values. The worker applies only the exact ordered pending prefix for that session, and only store-read canonical intent rows reach the callback. It durably replaces the complete JSON, then marks rows applied and advances SQLite's cursor in one transaction. Numeric gaps for globally allocated IDs belonging to other sessions are valid. Recovery acknowledges `JSON > SQLite` without reapplying and rejects `SQLite > JSON`; applied-row deletion is a later bounded operation limited by the acknowledged cursor. Mailbox payloads accept only strict JSON values and use stable object-key ordering; descriptor-only traversal prevents getters from executing, and invalid/cyclic/non-finite/sparse/accessor/non-plain values fail before a database write. Exact duplicate intent insertion is one database-level idempotent transaction across concurrent connections.

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
- SQLite acknowledgement can never advance before the authoritative JSON cursor.
- There is no session-worker catalog writer/coordinator, generic main-mutation claim, or release/handoff API in this foundation. Catalog delivery and lifecycle handoff are deferred to one closed supervisor-owned flow in the future real MessageRouter/SessionRuntime placement slice.
- Invalid/reused mailbox intent identities fail closed; exact idempotent repeats return the original record.
- Draining generations may publish one final revision before confirmed exit.
- The supervisor never treats IPC disconnect alone as permission to replace a worker.
- This process boundary provides fault containment and throughput placement, not security isolation.

## Integration status

The real child registers control plus runtime services behind one activation gate. `runPending` hydrates authoritative JSON once, applies the shared wait/drop/defer/enqueue transition to each validated QueueItem, acknowledges that bounded prefix, and runs the shared SessionTurnRunner against the same exact owner. Its current-session effects mark ToolContext as `session-worker`; direct, unified, and ToolScript-nested safe builtins retain that exact owner and canonical dispatcher. Current status/display/stop/archive/settings and master-local file/process operations use passed state, while still-unclosed Main topology, cross-session, unscoped memory-context, destructive, compaction, and managed-ToolScript operations fail with one retryable code before tool-start observability, concrete permission, or raw handler/singleton initialization. Node discovery reports explicit unavailability. ToolScript transient progress is intentionally dropped before child SessionManager notification until publication; persisted run/subcall records are unchanged. The bound turn host also routes child reminders/system events through that exact inline transition/persist path; it never lazily loads a same-ID global Session or writes the Main catalog. Managed-session state and any existing or incoming `compact-commit` fail closed before state replacement/ack. Explicit/background compact entry points always return `SESSION_WORKER_COMPACTION_UNSUPPORTED`; auto-compact uses the exact owner's canonical usage total/effective threshold and returns normally below threshold but raises the same explicit error above it. A failed run resynchronizes that object from authoritative JSON before returning the error, so already-durable queued work remains retryable without a new intent. A generic tool/settings persist failure likewise resynchronizes before later effects can continue; failed resync poisons the host until a later serialized run first reloads authority. Archive/journal and one per-worker ExecRuntime are initialized in the child. Before forward readiness, the child binds Main Management, Node execution, MCP external, and vector facades to one borrowed reverse transport. Main fences source-bearing handlers to that exact worker. Timeout wait, unified remote Node, MCP list/call, and bounded vector search are exercised through the production facades while Main waits on the forward run; the worker does not load a local vector owner. On forward drain, all borrowed clients fence/clear without owning the channel, then the reverse transport drains/closes exactly once before the store. Background exec completion is serialized on the same host chain, uses the timestamped system QueueItem plus shared wait transition, commits before dispatcher return, and schedules one non-retrying local processor whose failure leaves the durable item queued. Real-child/unit tests cover activation, nested reverse services, exact dispatch with forbidden global getters/savers and unchanged catalog bytes, exact child reminders, auto/explicit compact fail-closed behavior, wait/waitAll/timeouts, acknowledgement ordering, actual `set_goal` hook failure rollback, poison recovery, exec interleaving, archive/frontier/JSON output, unsupported managed/compact state, invalid payloads, and cloned projections. Supervisor/Main ingress routing, remaining service closure, committed projection application, external delivery, managed/compact execution, full tool closure, and idle release remain deferred, so production bootstrap still rejects `sessionWorkers:true`.

## Canonical ownership

The cross-module placement, durability, fencing, idle, and future worker-owned session decisions are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).
