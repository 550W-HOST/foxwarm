# Unit: src-session-manager

Files: src/sessionManager.ts, src/session/sessionIdAllocation.test.ts

## Purpose

`src/sessionManager.ts` is the compatibility façade and coordination boundary for session state. It owns the in-memory session map, lazy hydration, persistence orchestration, queue insertion, wait-state transitions, parent/child creation, channel delegation, managed-session wakeups, restart recovery, and callback registration. Domain implementations live under `src/session/*`.

`src/sessionRuntimeService.ts` wraps the high-level externally consumed subset in immutable DTO commands, queries, and events. The manager remains the local handler's live-object authority and the router's internal integration API; callers migrated to SessionRuntime should not recover a `Session` reference through this façade.

The LLM/tool turn loop is **not** implemented here. `MessageRouter.processSessionQueue()` delegates queued work to its `SessionTurnRunner`; `setSessionTriggerCallback()` connects this façade to that ingress method during bootstrap.

## Export groups

### Session identity, loading, and persistence

- `buildAgentMainSessionId`, `buildChildSessionId`, `validateChildSessionSuffix` — canonical agent-main and child identifiers.
- `resolveLoadedSessionId` — resolves a current ID/alias from the already-loaded catalog/in-memory identity map only, without filesystem lookup or semantic hydration. Exact real IDs win; cached aliases are accepted only while the loaded target still declares them, and duplicate current alias owners remain unresolved.
- `ARCHIVED_SESSION_ID_ERROR_CODE`, `ArchivedSessionIdError`, `assertSessionIdAvailableForNewLifetime` — the stable explicit-creation error and unified live/archive reservation boundary.
- `createSessionInAgentWithAutomaticName` — runs a caller-supplied automatic name generator inside the identity commit lock and retries reserved candidates.
- `getOrCreateSessionForChannel` — per-channel serialized first-session creation and attachment, with an optional guest/session factory and attachment config.
- `getExistingSession`, `getSession`, `createEmptySession`, `createSession`, `deleteSession`, `archiveSession` — lifecycle operations.
- `saveSession`, `saveSessionsMetadata`, `loadSessions`, `listSessions`, `getAllSessions`, `getSessionCatalog` — persistence and enumeration. `saveSession` accepts either an ID-backed local lookup or an exact supplied Session owner; both share the same state/metadata/index/event composition. `getSessionCatalog` is a Main-owned loaded-stub read that never hydrates worker authority.
- `setSessionCwd`, `setSessionChildModelDefault`, `setSessionCompactThreshold` — persisted session settings.
- `appendSessionMessage`, `appendSessionMessages`, `getSessionMessages` — durable history access. `appendSessionMessagesForSession` exposes the same sequence/image/archive/frontier/persist/notify composition for an exact supplied owner and persistence hook.

### Queue, wait, and execution coordination

- `applyQueuedItemToWaitState`, `enqueueSessionItem` — shared pure wait/drop/defer/enqueue transition plus canonical Main insertion with managed-inbox handling.
- `setSessionWorkerEnqueueSink` — registers the Session-worker placement sink; when set, the public `enqueueSessionItem` resolves a declared loaded alias to its canonical catalog ID, then routes every Main-side producer (typed event wrappers, RPC enqueue, inter-session delivery) through the one durable exact-ID ingress boundary without local hydration/queue/trigger writes. Managed sessions fail closed retryably instead of spawning a worker; raw coordinator calls still reject aliases. Without a sink the local path is unchanged.
- `setSessionWorkerDeleteHandler` / `setSessionWorkerForkSourceProvider` / `setSessionWorkerFenceChecker` — the Session-worker destructive-lifecycle, fork, and fence-lookup seams: delete entry points first let the hook tear down any worker fence (interrupt, graceful stop with handback, durable fence/mailbox removal) and fail closed on lifecycle errors before ordinary local deletion; fork ensures/loads the exact Worker and derives its source from a read-only detached snapshot instead of hydrating authority into Main; parent-relation moves are Main-owned catalog-only writes whenever Worker placement is enabled (and while an explicit fence remains).
- `claimSessionsForDestructiveLifecycle`, `releaseSessionsForDestructiveLifecycle`, `assertSessionDestructiveMutationAllowed` — bounded process-local WebUI delete coordination; mutation entry points reject late work/relation/channel changes while a claimed subtree is being deleted.
- `queueSessionEvent`, `queueSessionStructuredEvent`, `queueSessionMessageEvent`, `queueSessionSystemEvent` — typed event wrappers.
- `updateSessionBusyStateForSession`, `updateSessionBusyState` — exact-owner and current local metadata-backed forms of the same busy/busy-start/runtime-clear/persist/optional-notify transition. Persistence rejection normally restores the exact prior busy fields without clearing runtime state or notifying; an explicit exact-owner predicate may retain fields when persistence committed and only a postcommit publication failed. Successful release clears runtime only after persistence. Exact turn effects can use full owner persistence whose normal save already emits the state notification; legacy metadata-only callers supply the notification explicitly.
- `startSessionWaitForSession`, `startSessionWait`, `clearSessionWaitById`, `queueSessionWaitTimeoutEvent`, `clearSessionWaitForDirectTurn` — passed-owner and ID-loading forms of the same persisted wait mutation, token-aware surgical cleanup, and race-safe timeout events.
- `requestSessionStop`, `requestSessionDequeue`, `retrySession` — current run/queue controls; retry delegates directly to the router without queue persistence.
- `setSessionTriggerCallback`, `setSessionRetryCallback`, `triggerSessionProcessing`, `resumeBusySessions` — router/scheduler integration and restart recovery.
- `registerSessionAbortController`, `clearSessionAbortController`, `abortSessionInFlight` — active provider-request cancellation.

### Relations, agents, and inter-session delivery

- `forkSession`, `createChildSession`, `setSessionParent`, `updateChildSessionParentIds`, `getChildSessionIds`, `getCanonicalChildSessionIds`, `collectSessionDescendants` — lineage, explicit parent links, and canonical lifecycle traversal. `forkSession`/`createChildSession` accept a trusted `sourceOverride` snapshot so the Main management facade can fork a worker-fenced parent from a strictly read-only detached authority read without hydrating or persisting it.
- `sendToSession`, `notifyManualForkCreated` — inter-session and manual-fork events.
- `createAgentWithMainSession`, `createSessionInAgent`, `moveSessionToTarget`, `setAgentInherit`, `setAgentIsolation`, `refreshSessionSnapshot` — façade over agent operations. Under Worker placement, creation of new lifetimes remains Main-owned; same-source agent creation may consume one matching detached read-only source override for inherited model/node/agent-memory identity without hydrating the catalog stub. Existing-session identity conversion/move, another-source creation, and agent-wide snapshot-affecting inheritance/isolation changes fail before effects until a closed ownership path exists.
- `getAgentMetadata`, `getAgentInheritanceChain`, `getAgentIsolationNode`, `isAgentIsolated`, `isSessionEffectivelyIsolated` — agent metadata access.

### Channel and history façades

- Channel functions delegate to `src/session/channels.ts`: attachment lookup/mutation, direct text/file delivery, session broadcast setup, and attachment enumeration.
- Compaction/archive functions delegate to `src/session/history.ts`: threshold resolution, explicit/automatic compaction, completed-job application, archive reads, and tool-noise compaction.
- Runtime-state helpers are re-exported from `src/sessionRuntimeState.ts`.

### Update callbacks

- `setOnHistoryUpdated` and `setOnSessionEventUpdated` drive per-session streams.
- `setOnSessionListUpdated` drives global list consumers.
- `setOnSessionStateUpdated` drives targeted canonical session-state refreshes.
  SessionRuntime subscribes to these callback boundaries and republishes cloned history/list/state events to external consumers.

## Internal sections

- **Wait-state transition table:** maintenance items are wait-neutral; matching timeout tokens wake; stale tokens drop; `waitAllSessions` defers listed child messages until all requested sessions report.
- **Lazy hydration:** metadata creates lightweight session objects; `getSession` loads the per-session history snapshot and renders the embedded context frontier. A persisted live record remains hydratable even when archive rows exist, while an archive-only ID cannot implicitly start a new lifetime.
- **Image canonicalization:** history append assigns sequence identity before materializing images; saves canonicalize history, queue, and managed inbox images, while lazy hydration performs tolerant read-old/write-new conversion for accessed legacy sessions.
- **Session ID reservation:** one non-reentrant process-wide mutex spans check through strict commit for all public session creation/move façades. Nested implementation paths use private unlocked helpers; callback descendants cannot inherit a bypass capability. Automatic random/fork/child/timer allocation skips live IDs, aliases, and retained archive IDs.
- **Critical persistence:** creation/move paths use strict history/metadata/channel writers and roll back known failed attempts, including partial archive appends. Ordinary runtime saves remain best-effort where callers historically do not handle persistence errors.
- **Startup recovery:** pending identity-move recovery runs outside the ordinary best-effort load catch. Journal validation or recovery failure rejects initialization so partially recovered state is never loaded as a normal session stub.
- **Channel first-session creation:** a keyed channel/conversation lock makes lookup-create-durable-attach one flow. Factories report `{ session, created }`, so race/failure cleanup removes only a lifetime owned by that invocation and never a returned pre-existing session.
- **Child/fork creation:** copies or rebuilds prompt snapshots/cache lineage according to fork semantics, records archive lineage, and advances suffix counters past retained IDs.
- **Managed wakeup:** routes active managed-session input to its inbox and wakes or resumes its owner/controller with cooldown and stale-lease recovery.
- **Queue notification:** persists queue changes, emits state callbacks, and invokes the registered router trigger when work should run.
- **Restart recovery:** clears stale busy fields, appends/deduplicates the restart system event, retriggers queued work, and reclaims or wakes persisted managed inbox/controller state. Under Session-worker placement (enqueue sink registered), residual Main-local busy/queued/managed sessions are logged loudly and skipped rather than executed locally; their execution is left to the next durable Worker ingress.

## Dependencies

- `src/session/agentOps.ts`, `agentMetadata.ts`, `relations.ts`, `channels.ts`, `history.ts`, `metadataStore.ts`, `archive.ts`, `archiveStore.ts`, `layeredContext.ts`, and `managedState.ts` own their respective domains.
- `src/sessionRuntimeState.ts` owns the canonical runtime-state model.
- `src/migrations/` runs before normal lazy hydration. Throwing data-integrity migrations fail startup instead of entering the ordinary best-effort session-load catch.
- `src/vector.ts` is used for archive-index lifecycle operations, not agent-memory-file CRUD.
- `src/imageBlobs.ts` owns canonical image materialization and provider-compatible blob references.
- `src/llm.ts` is used only for prompt/cache helpers required by lifecycle operations; the router owns the live LLM loop.

## Invariants

- One `SessionTurnRunner.processSessionQueue()` invocation may claim a session at a time through the MessageRouter delegate; this façade persists and exposes the `busy` compatibility/concurrency flag.
- Per-session JSON files are authoritative for full semantic Session state, including conversation content, queue, wait/managed metadata, prompt/cache state, embedded `contextFrontier`, and the worker mailbox cursor. The shared metadata file is a main-owned index/presentation store.
- Operation ownership is stable under Worker placement: Session-semantic work must use the exact owner even when it must first spawn/load an idle Worker; Main catalog/topology/presentation work must remain catalog-only. The manager does not opportunistically hydrate and save authority simply because no Worker is currently active. Canonical decision: [D-process-topology-stable-operation-ownership](../threads/process-topology-and-rpc.md#d-process-topology-stable-operation-ownership).
- Lazy load upgrades only unversioned per-session files by seeding historically catalog-only fields, while current-format files exactly replace semantic stub state. Current local mode keeps the existing single main-owned `sessions.json` writer; Session-worker placement keeps catalog metadata Main-owned and receives bounded Worker projections through the SessionRuntime service.
- Queue insertion passes through wait-state and managed-inbox transitions before work is persisted or triggered.
- Retry and compact planning are not queue insertion paths. Async compact planning starts immediately from a snapshot; a busy `asyncCompact:false` explicit request reports unavailable; ready compact commits alone use the queue safe point.
- Generic history append persists and notifies only its supplied messages; router-owned goal evaluation is intentionally outside this low-level persistence path.
- Active `requesting-model` and `running-tool` phases are transient; persisted waits can survive restart.
- Forks share parent prompt/cache/archive prefix lineage; non-fork children start a fresh prefix.
- Session deletion clears runtime/pending compact state, the live map, attachments, session/legacy-frontier files, and shared metadata. Session history clear also removes any armed wait. Deletion currently leaves archive store/log and vector data intact; canonical scope is documented in [session lifecycle](../threads/session-lifecycle.md#archive-and-deletion).
- `archiveSessions` applies one archived state to an exact canonical ID set with one metadata save; recursive selection/preflight remains owned by the WebUI route. Canonical descendant behavior: [D-lifecycle-descendant-actions](../threads/session-lifecycle.md#d-lifecycle-descendant-actions).
- Destructive lifecycle claims are non-persisted and delete-only. They drain prior identity-lock work before acquisition, stabilize the selected canonical IDs across parent/child creation, identity move, channel attachment, queue/retry, and busy-start commit boundaries, and allow only the owning delete route to detach survivors/delete targets. Canonical contract: [D-lifecycle-descendant-actions](../threads/session-lifecycle.md#d-lifecycle-descendant-actions).
- A retained archive reserves its exact internal session ID across creation surfaces; existing persisted live records are still hydrated. Concurrent in-process creators and movers cannot both commit the same target. Canonical ownership: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Compatibility

- `busy`, `busyStartedAt`, and queue-length fields remain available to existing API readers; `runtimeState` is the canonical user-facing phase.
- Legacy channel attachment shapes and context-frontier files are handled by their dedicated readers/migrations, not by undocumented fallback logic in this façade.
- Existing child IDs under non-main parents retain append-style semantics. Agent-main child creation replaces the `main` leaf.
- Channel attachment no longer doubles as an implicit session allocator; creation chooses an available ID before attaching the channel.

## Design decisions

### D-session-wait-transition

All queue insertion uses one wait-state transition path. Compact maintenance is wait-neutral; stale timeout tokens are ignored; listed `waitAllSessions` messages are released together only after every requested source reports.

### D-session-restart-recovery

Busy-session restart recovery queues a self-closing current `kind="event" type="session-resumed"` wrapper with the restart-resume hint and source-boundary time. Dedup recognizes only that parsed current wrapper identity, not legacy raw text. Managed-owner wakeup dedup likewise parses its current wrapper and matches managed session ID plus pending count while ignoring time, body, and attribute order; a changed count is a new wakeup.

## Canonical ownership

- Façade versus domain/router boundary: [D-session-core-facade](../modules/session-core.md#d-session-core-facade).
- Child ID construction: [D-session-core-child-identity](../modules/session-core.md#d-session-core-child-identity).
- Prompt-cache/prefix inheritance and rotation: [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Manual fork parent event: [D-lifecycle-manual-fork-event](../threads/session-lifecycle.md#d-lifecycle-manual-fork-event).
- Archived internal-ID reservation: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
