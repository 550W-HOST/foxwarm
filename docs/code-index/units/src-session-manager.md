# Unit: src-session-manager

Files: src/sessionManager.ts, src/session/sessionIdAllocation.test.ts

## Purpose

`src/sessionManager.ts` is the compatibility façade and coordination boundary for session state. It owns the in-memory session map, lazy hydration, persistence orchestration, queue insertion, wait-state transitions, parent/child creation, channel delegation, managed-session wakeups, restart recovery, and callback registration. Domain implementations live under `src/session/*`.

The LLM/tool turn loop is **not** implemented here. `MessageRouter.processSessionQueue()` claims queued work and runs turns; `setSessionTriggerCallback()` connects this façade to that router method during bootstrap.

## Export groups

### Session identity, loading, and persistence

- `buildAgentMainSessionId`, `buildChildSessionId`, `validateChildSessionSuffix` — canonical agent-main and child identifiers.
- `ARCHIVED_SESSION_ID_ERROR_CODE`, `ArchivedSessionIdError`, `assertSessionIdAvailableForNewLifetime` — the stable explicit-creation error and unified live/archive reservation boundary.
- `createSessionInAgentWithAutomaticName` — runs a caller-supplied automatic name generator inside the identity commit lock and retries reserved candidates.
- `getOrCreateSessionForChannel` — per-channel serialized first-session creation and attachment, with an optional guest/session factory and attachment config.
- `getExistingSession`, `getSession`, `createEmptySession`, `createSession`, `deleteSession`, `archiveSession` — lifecycle operations.
- `saveSession`, `saveSessionsMetadata`, `loadSessions`, `listSessions`, `getAllSessions` — persistence and enumeration.
- `setSessionCwd`, `setSessionChildModelDefault`, `setSessionCompactThreshold` — persisted session settings.
- `appendSessionMessage`, `appendSessionMessages`, `getSessionMessages` — durable history access.

### Queue, wait, and execution coordination

- `enqueueSessionItem` — canonical queue insertion with wait-state and managed-inbox handling.
- `queueSessionEvent`, `queueSessionStructuredEvent`, `queueSessionMessageEvent`, `queueSessionSystemEvent` — typed event wrappers.
- `startSessionWait`, `clearSessionWaitById`, `queueSessionWaitTimeoutEvent`, `clearSessionWaitForDirectTurn` — persisted wait state, token-aware surgical cleanup, and race-safe timeout events.
- `requestSessionStop`, `requestSessionDequeue`, `retrySession` — current run/queue controls.
- `setSessionTriggerCallback`, `triggerSessionProcessing`, `resumeBusySessions` — router/scheduler integration and restart recovery.
- `registerSessionAbortController`, `clearSessionAbortController`, `abortSessionInFlight` — active provider-request cancellation.

### Relations, agents, and inter-session delivery

- `forkSession`, `createChildSession`, `setSessionParent`, `updateChildSessionParentIds`, `getChildSessionIds` — lineage and explicit parent links.
- `sendToSession`, `notifyManualForkCreated` — inter-session and manual-fork events.
- `createAgentWithMainSession`, `createSessionInAgent`, `moveSessionToTarget`, `setAgentInherit`, `setAgentIsolation`, `refreshSessionSnapshot` — façade over agent operations.
- `getAgentMetadata`, `getAgentInheritanceChain`, `getAgentIsolationNode`, `isAgentIsolated`, `isSessionEffectivelyIsolated` — agent metadata access.

### Channel and history façades

- Channel functions delegate to `src/session/channels.ts`: attachment lookup/mutation, direct text/file delivery, session broadcast setup, and attachment enumeration.
- Compaction/archive functions delegate to `src/session/history.ts`: threshold resolution, explicit/automatic compaction, completed-job application, archive reads, and tool-noise compaction.
- Runtime-state helpers are re-exported from `src/sessionRuntimeState.ts`.

### Update callbacks

- `setOnHistoryUpdated` and `setOnSessionEventUpdated` drive per-session streams.
- `setOnSessionListUpdated` drives global list consumers.
- `setOnSessionStateUpdated` drives targeted canonical session-state refreshes.

## Internal sections

- **Wait-state transition table:** maintenance items are wait-neutral; matching timeout tokens wake; stale tokens drop; `waitAllSessions` defers listed child messages until all requested sessions report.
- **Lazy hydration:** metadata creates lightweight session objects; `getSession` loads the per-session history snapshot and renders the embedded context frontier. A persisted live record remains hydratable even when archive rows exist, while an archive-only ID cannot implicitly start a new lifetime.
- **Session ID reservation:** one non-reentrant process-wide mutex spans check through strict commit for all public session creation/move façades. Nested implementation paths use private unlocked helpers; callback descendants cannot inherit a bypass capability. Automatic random/fork/child/timer allocation skips live IDs, aliases, and retained archive IDs.
- **Critical persistence:** creation/move paths use strict history/metadata/channel writers and roll back known failed attempts, including partial archive appends. Ordinary runtime saves remain best-effort where callers historically do not handle persistence errors.
- **Startup recovery:** pending identity-move recovery runs outside the ordinary best-effort load catch. Journal validation or recovery failure rejects initialization so partially recovered state is never loaded as a normal session stub.
- **Channel first-session creation:** a keyed channel/conversation lock makes lookup-create-durable-attach one flow. Factories report `{ session, created }`, so race/failure cleanup removes only a lifetime owned by that invocation and never a returned pre-existing session.
- **Child/fork creation:** copies or rebuilds prompt snapshots/cache lineage according to fork semantics, records archive lineage, and advances suffix counters past retained IDs.
- **Managed wakeup:** routes active managed-session input to its inbox and wakes or resumes its owner/controller with cooldown and stale-lease recovery.
- **Queue notification:** persists queue changes, emits state callbacks, and invokes the registered router trigger when work should run.
- **Restart recovery:** clears stale busy fields, appends/deduplicates the restart system event, retriggers queued work, and reclaims or wakes persisted managed inbox/controller state.

## Dependencies

- `src/session/agentOps.ts`, `agentMetadata.ts`, `relations.ts`, `channels.ts`, `history.ts`, `metadataStore.ts`, `archive.ts`, `archiveStore.ts`, `layeredContext.ts`, and `managedState.ts` own their respective domains.
- `src/sessionRuntimeState.ts` owns the canonical runtime-state model.
- `src/migrations/` runs before normal lazy hydration.
- `src/vector.ts` is used for archive-index lifecycle operations, not agent-memory-file CRUD.
- `src/llm.ts` is used only for prompt/cache helpers required by lifecycle operations; the router owns the live LLM loop.

## Invariants

- One `MessageRouter.processSessionQueue()` invocation may claim a session at a time; this façade persists and exposes the `busy` compatibility/concurrency flag.
- Session history files are authoritative for conversation content and the embedded `contextFrontier`; the shared metadata file is an index and presentation-metadata store.
- Queue insertion passes through wait-state and managed-inbox transitions before work is persisted or triggered.
- Generic history append persists and notifies only its supplied messages; router-owned goal evaluation is intentionally outside this low-level persistence path.
- Active `requesting-model` and `running-tool` phases are transient; persisted waits can survive restart.
- Forks share parent prompt/cache/archive prefix lineage; non-fork children start a fresh prefix.
- Session deletion clears runtime/pending compact state, the live map, attachments, session/legacy-frontier files, and shared metadata. Session history clear also removes any armed wait. Deletion currently leaves archive store/log and vector data intact; canonical scope is documented in [session lifecycle](../threads/session-lifecycle.md#archive-and-deletion).
- A retained archive reserves its exact internal session ID across creation surfaces; existing persisted live records are still hydrated. Concurrent in-process creators and movers cannot both commit the same target. Canonical ownership: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Compatibility

- `busy`, `busyStartedAt`, and queue-length fields remain available to existing API readers; `runtimeState` is the canonical user-facing phase.
- Legacy channel attachment shapes and context-frontier files are handled by their dedicated readers/migrations, not by undocumented fallback logic in this façade.
- Existing child IDs under non-main parents retain append-style semantics. Agent-main child creation replaces the `main` leaf.
- Channel attachment no longer doubles as an implicit session allocator; creation chooses an available ID before attaching the channel.

## Design decisions

### D-session-wait-transition

All queue insertion uses one wait-state transition path. Compact maintenance is wait-neutral; stale timeout tokens are ignored; listed `waitAllSessions` messages are released together only after every requested source reports.

## Canonical ownership

- Façade versus domain/router boundary: [D-session-core-facade](../modules/session-core.md#d-session-core-facade).
- Child ID construction: [D-session-core-child-identity](../modules/session-core.md#d-session-core-child-identity).
- Prompt-cache/prefix inheritance and rotation: [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Manual fork parent event: [D-lifecycle-manual-fork-event](../threads/session-lifecycle.md#d-lifecycle-manual-fork-event).
- Archived internal-ID reservation: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
