# Multiprocess Session Workers

This guide is the external-development handoff for Foxwarm's experimental session-worker placement. It describes the current implementation boundary, the work that is intentionally incomplete, and the order in which the remaining production path should be closed.

This is a development branch, not a production feature announcement. Source code and tests remain authoritative; update this guide when the current status or milestone order changes.

## Start here

Read these documents before changing the worker path:

1. [Process topology and RPC](./code-index/threads/process-topology-and-rpc.md) — canonical placement, authority, fencing, publication, and failure decisions.
2. [Session worker runtime unit](./code-index/units/src-session-worker-runtime.md) — Worker Store, Supervisor, Host, persistence, ingress, tests, and integration status.
3. [Message processing pipeline](./code-index/threads/message-processing-pipeline.md) — the one canonical turn runner and the normal local/Worker ingress boundary.
4. [Tool dispatch](./code-index/threads/tool-dispatch.md) — builtin ownership, reverse services, and the supported tool surface.
5. [Session lifecycle](./code-index/threads/session-lifecycle.md) — session creation, recovery, compaction, relations, and destructive lifecycle behavior.

The primary source entry points are:

- `src/sessionWorkerStore.ts` and `src/sessionWorkerStoreSchema.ts` — durable generation/incarnation and mailbox coordination;
- `src/sessionWorkerSupervisor.ts` — child lifecycle and exact-process fencing;
- `src/sessionWorkerPersistence.ts` and `src/sessionWorkerStableJson.ts` — authoritative JSON and save-before-ack recovery;
- `src/sessionWorkerHost.ts` — the child-owned exact Session and canonical turn runner;
- `src/sessionWorkerIngress.ts` — the bounded Main ingress operation for an already-activated Worker;
- `src/sessionTurnRunner.ts` — the single local/Worker turn implementation;
- `src/sessionRuntime.ts` and `src/sessionRuntimeService.ts` — Main presentation, query, and event boundaries;
- `src/rpc/` plus the fixed Main-owned service facades — local and child placement contracts.

## Current status

The implementation has a substantial real-child foundation, but normal production placement is deliberately disabled.

| Area | Current state |
| --- | --- |
| `sessionWorkers` | Defaults off. Production startup still rejects `sessionWorkers:true` with `SESSION_WORKERS_NOT_IMPLEMENTED`. |
| `dbWorkers` | Defaults on and currently means only the LanceDB/vector owner. Archive and LLM-request-journal SQLite are not moved behind this worker. |
| Session authority | `state/sessions/<id>.json` is the full semantic authority. Main remains the sole shared `sessions.json` catalog writer. |
| Ownership | One durable generation/incarnation owns one hot Session. Exact process identity, inert candidates, exit confirmation, and stale-generation fencing are implemented. |
| Mailbox | Main can validate and persist one ordinary QueueItem for an already-ready exact Worker; JSON replacement precedes mailbox acknowledgement. |
| Turn execution | `SessionWorkerHost` invokes the same `SessionTurnRunner` used by local placement. There is no reduced Worker-only turn state machine. |
| Publication | Full bounded committed projections are awaited after authoritative writes. There is no persisted `stateRevision`. |
| History and compaction | Detached authoritative history reads and synchronous awaited Worker compaction are implemented and tested. Background compact jobs remain unsupported. |
| Final delivery | Main-owned committed-final delivery carries a serialized QueueSource and makes one delivery attempt after commit/publication. There is no outbox or automatic retry. |
| Tool placement | Fixed Main reverse services cover the implemented Worker paths for management, Node execution, file delivery, final delivery, MCP, vector, and publication. Unsupported paths fail explicitly before effects. |
| Normal ingress | `MessageRouter` now routes ordinary busy/idle channel/WebUI input through the closed ensure/spawn/append/run ingress operation (`submitEnsuringWorker`) when Session-worker placement injects its submit handler. Startup still rejects `sessionWorkers:true`; timer, wait-timeout, ONBOOT, node, and other event triggers still use the local gate pending their audit. |
| Lifecycle handback | Complete authority reload, Main-stub handback, idle/crash release, and background-exec-aware release are not yet an activated production flow. |

The distinction is important: a passing real-child test proves a closed seam, not that `sessionWorkers:true` is ready for ordinary users.

## What is already implemented

### Durable ownership and authority

- Main records one generation/incarnation fence per Session and never treats an IPC disconnect alone as permission to replace a child.
- A candidate is inert until Main has durably registered and activated the exact process identity.
- The Worker hydrates the per-session JSON authority and applies only an ordered session-local mailbox prefix.
- The Worker durably replaces JSON before advancing the SQLite acknowledgement cursor.
- JSON ahead of SQLite is reconciled without reapplying the prefix; SQLite ahead of JSON fails closed.
- Worker commits publish cloned bounded projections. Ambiguous publication, lifecycle changes, and failed reloads require resynchronization rather than semantic rollback or a second authority.

### Canonical turn path

- Local and Worker placement share one `SessionTurnRunner`.
- The Worker owns hot Session state, provider/tool loop work, the local archive/journal handles, and its process-local `ExecRuntime`.
- Main does not receive full history, prompt serialization, mutable Session references, callbacks, or tool output through a generic payload broker.
- Safe-point compaction is synchronous and reuses the existing history engine. It does not create a compact mailbox item or a background compact state machine.

### Main-owned services

The child borrows one trusted reverse transport for fixed services rather than using child-local fallbacks. Implemented service seams include:

- Main management and timeout scheduling;
- authenticated Node execution and bounded Node topology/file-copy operations;
- file delivery without reverse file bytes or base64;
- committed final delivery with serialized source intent;
- MCP external operations;
- bounded vector calls through Main's selected vector facade;
- complete committed-state publication.

Each service has a versioned serializable DTO/error boundary and exact Worker source fencing. The process boundary is for fault containment and throughput, not security isolation.

## Remaining milestones

Work through these milestones serially. Do not activate the next one by adding a generic coordinator or a second queue.

### M-A — close normal ingress and inactive spawn

Build one supervisor-owned production operation for ordinary inbound work:

1. resolve the canonical Session identity;
2. ensure or spawn an inactive exact Worker generation;
3. durably append the existing normalized QueueItem mailbox intent;
4. invoke that same Worker's existing `runPending` path;
5. preserve ambiguous post-append outcomes as durable work without local fallback.

Steps 1–5 exist as `SessionWorkerIngressCoordinator.submitEnsuringWorker`: the ingress coordinator composes resolve/ensure/append/run while the `SessionWorkerSupervisor` alone owns the spawn/candidate/activation lifecycle and fencing. Real-child tests cover spawn-to-ready, concurrent single-flight ensures, crash fencing until durably observed exit, and unprovable-identity fail-closed behavior. `MessageRouter` now uses this operation for ordinary busy/idle channel/WebUI input when placement injects its submit handler, and worker-fenced sessions reject stop/dequeue/retry controls retryably.

Remaining for M-A: audit timer, wait-timeout, ONBOOT, node, and other event triggers so they cannot bypass the durable ingress boundary, then reconsider the startup gate.

### M-B — close lifecycle handback and release readiness

Add the concrete lifecycle flow for idle, crash, shutdown, and replacement:

- block replacement while the old generation is draining or exit is unconfirmed;
- confirm the exact process has exited;
- reload and reconcile the authoritative JSON in Main;
- replace or refresh the Main presentation stub without writing semantic authority from the projection;
- account for Worker-owned background exec processes and their durable completion notifications;
- release the fence only after the handback/save boundary is complete.

Keep this as one closed flow. Do not introduce a reusable claim, lease, callback, or opaque handoff capability API without a real caller.

### M-C — close normal cross-session and topology callers

Provide fixed services only for reachable normal callers that are still unavailable in Worker placement. Start with child creation and its required reply/wait behavior, then query/control/settings paths that genuinely need Main-owned state. Keep unsupported admin and managed paths explicit until their concrete product callers are defined.

### M-D — close concrete destructive lifecycle operations

For stop/delete/archive/fork or other destructive operations, define each supported operation's authority reload, generation fence, persistence, and replacement behavior. Implement a real closed operation rather than a generic mutation protocol.

### M-E — optional managed/admin closure

Only after normal UI/channel paths work should managed-session, pairing/bootstrap, destructive admin, or other low-frequency surfaces be reconsidered. A path may remain explicitly unavailable if it has no supported Worker caller in the first release.

### Final activation gate

Before changing the production default or allowing `sessionWorkers:true`, verify all of the following against real callers:

- ordinary channel/WebUI ingress and all normal event triggers use the durable Worker path;
- inactive spawn, crash recovery, idle release, shutdown, and replacement preserve one exact authority;
- Main projection/history presentation never hydrates semantic state as a fallback;
- all normal default-schema tools either execute through the exact Worker owner or have a clearly reachable fixed Main service;
- final delivery, waits, ToolScript persistence, archive/journal writes, and background exec completion have one supported path;
- publication ambiguity and Worker restart resynchronize before later mutation;
- the production test environment has exercised the real path with `sessionWorkers:true` enabled;
- no security-isolation claim, persisted `stateRevision`, outbox, generic claim/lease protocol, or second turn state machine has been added without an explicit product decision.

## Non-negotiable design boundaries

These are current decisions, not suggestions for a new implementation:

- **One runner:** local and Worker placement use the canonical `SessionTurnRunner`.
- **One authority:** `state/sessions/<id>.json` is the complete semantic authority; Main remains the catalog writer.
- **No persisted revision:** committed publication uses reliable awaited full bounded projections and authoritative resync, not a new persisted `stateRevision`.
- **Trusted placement:** Session workers stay inside the Main trusted host/deployment boundary. Remote nodes are bounded execution targets, not Session-worker hosts.
- **No generic claims:** do not restore the removed catalog coordinator, mutation-claim, release, or opaque-capability abstractions without a concrete supported caller.
- **No local fallback after Worker selection:** an ambiguous durable Worker submission remains durable and retryable; it must not silently run a second local turn.
- **No first-version delivery ledger:** final external delivery is one Main attempt after canonical commit/publication; there is no automatic retry or outbox in this release.
- **No speculative hardening:** prioritize normal supported callers and real data-integrity/failure consequences over artificial hostile same-process scenarios.

## Build and test workflow

From a clean checkout after source changes:

```sh
npm run build
npm run quality:unused
npm run quality:code-index
```

The focused Worker closure can be run after the build with synchronous file logging so child-test processes exit cleanly:

```sh
FOXWARM_SYNC_FILE_LOG=1 node --test --test-concurrency=1 \
  lib/sessionWorkerIngress.test.js \
  lib/sessionWorkerHost.test.js \
  lib/sessionRuntimeService.test.js \
  lib/sessionWorkerToolPlacement.test.js \
  lib/sessionWorkerPublicationService.test.js \
  lib/sessionTurnDelivery.test.js \
  lib/fileDeliveryService.test.js \
  lib/fileDeliveryExternalPlacement.test.js
```

Also run the relevant local canonical-path tests when changing turn semantics:

```sh
FOXWARM_SYNC_FILE_LOG=1 node --test --test-concurrency=1 \
  lib/messageRouter.test.js \
  lib/sessionTurnRunnerDetachedOwner.test.js
```

A change to backend/runtime code requires restarting the test environment before runtime validation. A frontend-only change normally needs a rebuild and browser refresh rather than a container restart.

## Contribution checklist

Before handing work to the next developer:

- Read the relevant code-index overview, thread, module, and unit documents.
- State the supported production caller and the exact boundary being closed.
- Add or update focused tests, including a real child/fork test for a cross-process contract.
- Update the canonical code-index owner in the same change; keep decisions in one owner and keep docs English and public-safe.
- Run build, unused checks, code-index quality, and the smallest relevant focused suites.
- Keep `sessionWorkers` production-gated until the final activation gate is met.
- Report whether the test backend was restarted and whether a test node was actually available.
