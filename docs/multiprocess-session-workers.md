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

The implementation has a substantial real-child foundation, but Session-worker placement remains experimental and defaults off. Deployments should keep `sessionWorkers` omitted or explicitly disabled unless they are intentionally evaluating the experimental placement.

| Area | Current state |
| --- | --- |
| `sessionWorkers` | Defaults off. When enabled, production bootstrap assembles the store/supervisor/ingress and routes the normal-ingress vertical slice through Workers. |
| `dbWorkers` | Defaults on and currently means only the LanceDB/vector owner. Archive and LLM-request-journal SQLite are not moved behind this worker. |
| Session authority | `state/sessions/<id>.json` is the full semantic authority. Main remains the sole `state/catalog.sqlite` writer. |
| Ownership | One durable generation/incarnation owns one hot Session. Exact process identity, inert candidates, exit confirmation, and stale-generation fencing are implemented. |
| Mailbox | Main validates and persists ordinary QueueItems through the closed ensure/spawn exact-owner ingress; JSON replacement precedes mailbox acknowledgement. |
| Turn execution | `SessionWorkerHost` invokes the same `SessionTurnRunner` used by local placement. There is no reduced Worker-only turn state machine. |
| Publication | Full bounded committed projections are awaited after authoritative writes. There is no persisted `stateRevision`. |
| History and compaction | Detached authoritative history reads, synchronous awaited layered compaction, and serialized exact-owner `/compact tools` rewriting are implemented and tested. Background compact jobs remain unsupported. |
| BTW side requests | `/btw` snapshots the exact owner and runs provider work without tools, streams, or turn abort registration. Busy Worker provider work may overlap the active turn; one display-only result append/persist/projection waits for the owner lane and then broadcasts through Main's existing attachment path. |
| Final delivery | Main-owned committed-final delivery carries a serialized QueueSource and makes one delivery attempt after commit/publication. There is no outbox or automatic retry. |
| Tool placement | Fixed Main reverse services cover management, Node execution, file delivery, final delivery, MCP, vector, and publication. Cross-session recall/archive reads, Main-owned agent/session creation, and node bootstrap/pairing now use the exact-source-fenced Main-management facade; current-session/current-agent recall remains Worker-owned. Identity conversion/move and agent-wide inheritance/isolation changes remain pre-effect fenced. |
| Normal ingress | `MessageRouter` routes ordinary busy/idle channel/WebUI input through the closed ensure/spawn/append/run ingress operation (`submitEnsuringWorker`), and all Main-side enqueue producers share the same durable boundary. Exact fenced stop, dequeue, and canonical retry use closed exact-owner operations. Dequeue signals an active owner immediately and continues pending durable input through the same action loop; retry creates no mailbox item or second queue and rejects active overlap. Managed sessions remain unavailable. |
| Lifecycle handback | Idle/crash/shutdown release runs one closed supervisor-owned flow: the supervisor's single injected Main handback step reconciles the mailbox cursor against the authoritative JSON and refreshes the Main catalog stub read-only before the fence is released; handback failure retains the fence fail-closed. Idle release postpones while the worker reports a busy owner, queued work, or running background exec processes via the exact `idleStatus` runtime method. |

The distinction is important: a passing real-child test proves a closed seam, not that `sessionWorkers:true` is ready for ordinary users.

## Downgrade and rollout contract

`sessionWorkers:false` changes the active placement; it does not retire durable Worker lineage. Draining every Worker, reaching zero pending mailbox rows, and restarting in local mode are necessary operational steps, but they are not sufficient preparation for running code from before the Session-worker state format.

- A Session that has never used Worker ingress has cursor `0` and no nonzero ownership/mailbox lineage. Its current version-1 JSON remains readable by pre-Session-worker code. If that old code saves the Session, it removes the version/cursor fields; current code can later perform its normal legacy upgrade and restore cursor `0` safely.
- After a Session has any nonzero Worker cursor/lineage, running pre-Session-worker code against it is unsupported. An old local save preserves ordinary history but removes `sessionStateVersion` and `lastAppliedMailboxId`, while `session-runtime.sqlite` still records the nonzero acknowledged cursor. Current code must treat that SQLite-ahead condition as impossible and fail closed; it must never infer the missing JSON cursor from SQLite.
- Foxwarm does not provide or require lineage-retirement tooling. Current-code `sessionWorkers:false` remains supported and preserves nonzero lineage, but pre-Session-worker code remains unsupported as a writer for that lineage. Do not claim that draining or disabling Workers changes this boundary.
- If an unsupported downgrade has already rewritten a nonzero-lineage authority, recover the verified matching authority/catalog/runtime-database backup set or remain on current code and follow a separately reviewed evidence-bound recovery. Do not manufacture a cursor, add a second cursor mirror, or continue old-code writes.

Keep Session workers off for observation deployments that may need to return to pre-Session-worker code. The canonical compatibility decision is [D-process-topology-session-worker-downgrade](./code-index/threads/process-topology-and-rpc.md#d-process-topology-session-worker-downgrade).

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
- Safe-point layered compaction is synchronous and reuses the existing history engine. `/compact tools` is a separate serialized exact-owner history rewrite. Neither creates a compact mailbox item or a background compact state machine.
- BTW uses the same provider/tool schema against a detached exact snapshot, suppresses stream/abort hooks, denies returned tool calls, and serializes only its final display-only append. It has no mailbox item or pending-result protocol.

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

### M-A — close normal ingress and inactive spawn ✅ completed

Build one supervisor-owned production operation for ordinary inbound work:

1. resolve the canonical Session identity;
2. ensure or spawn an inactive exact Worker generation;
3. durably append the existing normalized QueueItem mailbox intent;
4. invoke that same Worker's existing `runPending` path;
5. preserve ambiguous post-append outcomes as durable work without local fallback.

Steps 1–5 exist as `SessionWorkerIngressCoordinator.submitEnsuringWorker`: the ingress coordinator composes resolve/ensure/append/run while the `SessionWorkerSupervisor` alone owns the spawn/candidate/activation lifecycle and fencing. Real-child tests cover spawn-to-ready, concurrent single-flight ensures, crash fencing until durably observed exit, and unprovable-identity fail-closed behavior. `MessageRouter` uses this operation for ordinary busy/idle channel/WebUI input, and the session-manager enqueue sink routes every Main-side event trigger (timer, wait-timeout, ONBOOT, node events, RPC enqueue, inter-session delivery) through the same durable boundary. Exact stop, dequeue, Continue/retry, normal settings, history mutations, indexing, snapshot refresh, and tool-noise compaction use typed Worker operations rather than Main authority writes. The startup gate is lifted: bootstrap assembles the worker foundation when `sessionWorkers` is enabled and non-fatally resumes durable pending mailbox intents. Managed sessions fail closed at the shared boundary and remain deferred to M-E.

### M-B — close lifecycle handback and release readiness ✅ completed

Add the concrete lifecycle flow for idle, crash, shutdown, and replacement:

- block replacement while the old generation is draining or exit is unconfirmed;
- confirm the exact process has exited;
- reload and reconcile the authoritative JSON in Main;
- replace or refresh the Main presentation stub without writing semantic authority from the projection;
- account for Worker-owned background exec processes and their durable completion notifications;
- release the fence only after the handback/save boundary is complete.

Keep this as one closed flow. Do not introduce a reusable claim, lease, callback, or opaque handoff capability API without a real caller.

Implemented: the supervisor owns the flow; its one injected `handbackWorker` step (Main-side `performSessionWorkerHandback`, not a generic callback API — it has exactly one caller, exit/stop handback) runs after exact exit observation and before `markExitObserved`, reconciling the cursor via `SessionWorkerStore.reconcileDrainedMailboxCursor` (draining-state variant of the inactive reconcile) and refreshing the Main catalog stub strictly read-only from the authority JSON (never the projection). Handback failure retains the fence on both stop and crash paths and blocks restart/replacement; an exit inside the activation window (candidate state) skips the handback entirely so the fence releases and the session stays retryable. Idle release queries the worker's exact `idleStatus` and postpones while busy/queued/running background exec; shutdown and explicit stop do not wait for background exec (their completion is durably recovered at the next spawn).

### M-C — close normal cross-session and topology callers ✅ completed

Provide fixed services only for reachable normal callers that are still unavailable in Worker placement. Start with child creation and its required reply/wait behavior, then query/control/settings paths that genuinely need Main-owned state. Keep unsupported admin and managed paths explicit until their concrete product callers are defined.

Implemented: the version-4 main-management facade has a fixed 20-operation allowlist. In addition to child/catalog/message operations, it closes cross-session `recall` and hidden archive readers, Main-owned `create_agent`/`create_session`, other-target `delete_session`, and node bootstrap/pair list/approval. Reverse handlers fence exact generation/incarnation before effects and cap operation-specific args; recall preserves scope/isolation and exact archive/vector source reload, creation derives inherited settings from a detached source authority, and deletion repeatedly fences the source generation while composing the shared Main lifecycle orchestrator. Source conversion and self/alias deletion remain fenced. Real-child tests exercise the closed operations, stale-source rejection, and direct/unified/ToolScript placement.

### M-D — close concrete destructive lifecycle operations ✅ completed

For stop/delete/archive/fork or other destructive operations, define each supported operation's authority reload, generation fence, persistence, and replacement behavior. Implement a real closed operation rather than a generic mutation protocol.

Implemented per operation: **stop** — control `stop` on a fenced session routes to the worker runtime `interrupt` through the exact supervisor fence. **dequeue** — one typed exact-owner control counts the hot queue plus already-durable pending ingress, signals `stopping`/`runQueuedAfterStop`, aborts an active provider without waiting behind the turn, and ingests pending input at the stop-override safe point so the same canonical outer action loop continues it; idle queued work uses that runner and empty work is a no-op. **retry** — slash/WebUI Continue ensures the exact Worker and invokes the canonical `parts:null` retry turn with serialized source/final-delivery metadata; it has no mailbox row or duplicate history algorithm and rejects active overlap definitely. A lost response after invocation reports `SESSION_WORKER_RETRY_OUTCOME_UNKNOWN` and instructs history inspection because commit/delivery may already have happened; it never falls back or auto-retries. **delete** — one Main-owned orchestrator now serves nonrecursive WebUI, `/session delete`, and model `delete_session`, while explicit recursive WebUI delete remains separate. A Worker model may delete another permitted local or Worker-owned target; Main repeatedly fences the exact source generation, performs existing channel/busy/claim/revalidation checks, tears down exact Worker targets through interrupt/stop/handback/fence removal, detaches surviving children, and runs ordinary cleanup. The existing identity lock serializes delete-claim acquisition against concrete Worker ensure/mailbox admission or activated-call acceptance, preventing an ingress begun just before the claim from creating a later owner/mailbox effect. Cross-session model deletes also hold one narrow source-plus-target conflict admission, so reciprocal or overlapping calls return retryable `SESSION_DELETE_CONFLICT` before the later call can drain the first call's active source; this does not claim or stall ordinary source turn completion. Canonical source or alias self-delete remains forbidden. **fork/archive/displayName** retain their closed detached/catalog-only paths.

### M-E — optional managed/admin closure ✅ partially closed

Only after normal UI/channel paths work should managed-session and identity-wide admin surfaces be reconsidered. A path may remain explicitly unavailable when its stable ownership/lifecycle boundary is not closed.

Audit result (worker placement, per surface):

- **Managed sessions (ToolScript managed controller)** — explicitly unavailable: the enqueue sink fails managed sessions closed (`SESSION_WORKER_QUEUE_UNSUPPORTED`, never spawns a worker), managed ToolScript operations fail `SESSION_WORKER_TOOL_UNAVAILABLE` before effects, managed session state in a worker fails closed, and residual managed queue entries at startup are fail-loud skipped. Intentional: no supported Worker caller in the first release.
- **Pairing/bootstrap** — closed through exact-source-fenced Main topology operations.
- **Agent/session creation** — `create_agent` from the exact current detached source (without conversion) and `create_session` are closed; another-source creation, `set_agent_inherit`, `set_agent_isolated`, `move_session`, and source conversion remain fenced because they need additional authority/identity coordination.
- **Recall** — cross-session exact/vector recall and hidden archive range/block readers are closed through Main; unscoped legacy `get_memory_context` remains fenced.
- **Cross-session control/settings** — the current-session command/runtime dequeue path and normal Worker-owned settings are closed through typed exact-owner operations; broader model-facing cross-session control remains unavailable.
- **Residual `compact-commit` queue entries** — remain fail closed; no migration/cleanup work is planned for this stage.
- **Parent-relation moves** (WebUI move/promote, delete-detach) — the audit found one quiet wrong behavior: `setSessionParent`/`updateChildSessionParentIds` wrote the fenced child's authority from Main (an unhydrated stub write could corrupt it). Fixed: fenced parent moves are Main-owned catalog-only writes guarded by the fence checker; authority bytes are untouched.
- **Other Main low-frequency surfaces** — pin/sidebarOrder/archive/displayName are pure catalog writes (open); cwd/model/childModel/current-node/compact-threshold/verbose settings route to the exact Worker owner; WebUI state/history/context-blocks/debug-file are read-only DTO/projection/detached paths.

Activation gate checklist status:

- ordinary channel/WebUI ingress and all normal event triggers use the durable Worker path — **met** (A2/A3).
- inactive spawn, crash recovery, idle release, shutdown, and replacement preserve one exact authority — **met** (A1/A3/M-B + stale-busy recovery).
- Main projection/history presentation never hydrates semantic state as a fallback — **met** (detached reads; handback clears hydrated stubs; facade/catalog-map-only existence checks; fenced parent moves catalog-only).
- all normal default-schema tools either execute through the exact Worker owner or have a clearly reachable fixed Main service — **met** (M-C facade set + placement fences; managed/admin surfaces explicitly unavailable).
- final delivery, waits, ToolScript persistence, archive/journal writes, and background exec completion have one supported path — **met** (verified in the production test environment, including the waitAfterHandoff chain).
- publication ambiguity and Worker restart resynchronize before later mutation — **met** (M-B; poison/resync rules).
- the production test environment has exercised the real path with `sessionWorkers:true` enabled — **met** (runtime verification; defects found there are fixed and regression-covered).
- no security-isolation claim, persisted `stateRevision`, outbox, generic claim/lease protocol, or second turn state machine has been added — **met**.

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
- **One authority:** `state/sessions/<id>.json` is the complete semantic authority; Main alone writes the identity/topology projection in `state/catalog.sqlite`.
- **No persisted revision:** committed publication uses reliable awaited full bounded projections and authoritative resync, not a new persisted `stateRevision`.
- **Trusted placement:** Session workers stay inside the Main trusted host/deployment boundary. Remote nodes are bounded execution targets, not Session-worker hosts.
- **No generic claims:** do not restore the removed catalog coordinator, mutation-claim, release, or opaque-capability abstractions without a concrete supported caller.
- **No local fallback after Worker selection:** an ambiguous durable Worker submission remains durable and retryable; it must not silently run a second local turn.
- **No first-version delivery ledger:** final external delivery is one Main attempt after canonical commit/publication; there is no automatic retry or outbox in this release.
- **No speculative hardening:** prioritize normal supported callers and real data-integrity/failure consequences over artificial hostile same-process scenarios.
- **No implicit downgrade after Worker lineage:** current-code local placement remains supported, but disabling/draining does not make a nonzero-lineage Session safe for pre-Session-worker saves; no lineage-retirement tooling is required.

## Open questions

- Runtime verification found and fixed three activation-gate defects: (1) the session-manager enqueue sink awaited the target's full turn, so an awaited inter-session send (for example `waitAfterHandoff:true`) deadlocked when the target replied to its busy-mid-turn source — the sink now durably appends and triggers processing detached, with channel/WebUI ingress still awaiting its own reply; (2) an unconfirmed exit could leave a stale authoritative busy flag with no pending intent and no trigger — a fresh worker now clears the stale flag and enqueues one restart system event inside its own ownership on load, and startup resume eagerly scans authority JSON busy flags alongside pending intents; (3) `tools.ts` eagerly captured facade wrapper bindings that are undefined under worker process load order (dependency cycle), so the named re-exports are lazy call-throughs. Graceful drain of a legitimately mid-turn worker is bounded by design (drain timeout escalates to bounded termination; recovery semantics above handle the aftermath).
- When a Worker submission fails at channel ingress (for example a transient spawn/ensure failure), the error propagates to the channel handler without a user-facing retry notice. Whether channels should surface or retry such failures is a product decision; the current behavior is intentional and unchanged.
- Residual Main-local queue entries that survive a local-to-worker switch may contain `compact-commit` items; the worker's `assertSupportedQueue` fails those closed on every `runPending`. The behavior is safe (no semantic loss, explicit error); recorded here only as an observation.
- displayName semantic gap: handback cannot distinguish "never named" from "explicitly cleared" (both are an absent catalog name). An explicit clear is preserved across rehydration (Main-owned) but a later handback may adopt the authority's stale name back into the unnamed stub. Marginal in practice (clearing a fenced session's name is rare); recorded as a known edge.

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
  lib/sessionWorkerEnsureIngress.test.js \
  lib/sessionWorkerRouterIngress.test.js \
  lib/sessionWorkerTriggerIngress.test.js \
  lib/sessionWorkerHandback.test.js \
  lib/sessionWorkerCrossSession.test.js \
  lib/sessionWorkerCrashRecovery.test.js \
  lib/sessionWorkerDestructive.test.js \
  lib/sessionWorkerSupervisor.test.js \
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
