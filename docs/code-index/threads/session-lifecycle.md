# Thread: session lifecycle

## Overview

Cross-module lifecycle from public creation through lazy hydration, queued execution, compaction/archive lineage, parent-child/fork behavior, restart recovery, archival, and coordinated deletion.

## Creation surfaces

- `createEmptySession(sessionId?)` is the simple public façade. It returns an existing session when present or lazily creates/saves an empty one and reports `{ session, created }`.
- `createSessionInAgent(options)` is the agent-aware public creation surface for a named session with display/node/model/effort/parent/prompt-file options.
- `createAgentWithMainSession(options)` owns agent creation plus optional main session.
- Low-level `createSession(sessionId, sessionData)` accepts a fully constructed session object, ensures its prompt-cache key, installs it in the map, and saves it. It does **not** allocate an ID from an options object.
- `forkSession` and `createChildSession(parentSessionId, suffix, fork, options)` own fork/non-fork child creation.
- A new session lifetime may use an internal session ID only when the ID is absent from both live persistence and the retained archive. One non-reentrant process-wide identity lock makes check-and-commit atomic across explicit creation, automatic allocation, agent-main creation, forks/children, and internal-ID moves; nested implementation calls use private unlocked helpers rather than ambient lock ownership. Automatic allocators skip reserved IDs; explicit creation returns `SESSION_ID_ARCHIVED` for an archive-only collision.

Canonical façade and child-ID ownership: [session core façade](../modules/session-core.md#d-session-core-facade) and [child identity](../modules/session-core.md#d-session-core-child-identity).

## Persistence and hydration

1. Startup migrations run before normal loading.
2. `loadSessions()` loads the metadata index, creates lightweight session objects, and loads channel attachments.
3. `getSession(id)` lazily loads the authoritative per-session history snapshot.
4. When an embedded `contextFrontier` exists, hydration calls `renderHistoryFromFrontier(session)` or annotates an already matching rendered history.
5. Accessed legacy live history/queue images are lazily materialized into canonical content-addressed blob references; there is no startup-wide image migration.
6. The shared metadata file remains a main-owned presentation/list index; the per-session JSON owns full semantic state, including messages, queue, wait/managed metadata, prompt snapshot/cache key, frontier, and any session-worker mailbox cursor.
7. Creation-critical history and metadata writes propagate errors. A known failed creation removes its map/history/archive artifacts so the same uncommitted ID can be retried; ordinary noncritical saves retain best-effort logging behavior.

Canonical data authority: [D-session-core-authoritative-history](../modules/session-core.md#d-session-core-authoritative-history).

## Active turn and restart

- Queue insertion and persisted wait-state transitions live behind the session façade.
- `MessageRouter.processSessionQueue()` claims the session and runs the provider/tool loop; session core does not own that loop.
- `resumeBusySessions()` inspects metadata-only busy/queued/managed-inbox state. It clears stale busy fields and appends or deduplicates a restart event, retriggers queued work, and reclaims or wakes persisted managed inboxes/controllers. Under Session-worker placement, residual Main-local busy/queued/managed sessions are logged loudly and skipped rather than executed locally; durable mailbox intents resume through the non-fatal ensure/run path owned by [process topology and RPC](./process-topology-and-rpc.md), and residual local work runs only at the next durable Worker ingress.

Canonical turn flow: [message processing pipeline](./message-processing-pipeline.md).

## Context, archive, and recall

- Final usage may trigger `checkAndCompactIfNeeded`.
- Compaction plans against a snapshot and commits only a compatible consumed prefix.
- Frontier rendering uses `renderHistoryFromFrontier`.
- Current archive appends commit only to the SQLite authority; effective reads enforce fork lineage caps, and vector indexing may lag without losing source data.

Canonical contract: [context compaction and recall](./context-compaction-and-recall.md), especially [SQLite archive authority](./context-compaction-and-recall.md#d-context-sqlite-archive-authority).

## Child and fork lifecycle

- Agent-main children replace the `main` leaf; non-main children retain append-style IDs.
- Fork and child allocators skip both live and archived IDs while incrementing their suffix counters.
- Forks copy the model-visible prefix/frontier/snapshot and inherit prompt-cache/archive lineage only through the fork point.
- Non-fork children start a fresh model-visible prefix and cache key.
- Forked and non-fork children resolve raw model effort as explicit effort, parent `childEffortDefault`, parent raw `effort`, then unset; unset never freezes a concrete model default into the child.
- A manual user fork calls `notifyManualForkCreated` so the parent history records the child even when no initial instruction was supplied.

## Manual-fork event

`notifyManualForkCreated(parentSessionId, childSessionId, initialMessage?)` creates a user-role structured session event:

- metadata uses `kind="session-event"`, `event="manual-fork-created"`, current parent ID, child ID, and `(none)` when there is no initial message;
- an idle parent receives an appended durable history message with goal-reminder suppression and is not triggered merely by that append;
- a busy parent receives the same notification as a background queue item;
- an initial instruction, when supplied, is queued to the child by the fork command path independently of this parent notice.

## Archive and deletion

- `archiveSession(id, archived)` is a presentation/lifecycle flag, not physical deletion.
- WebUI archive may optionally apply the archived flag to the backend-recomputed canonical descendant graph. Recursive archive traverses through descendants that are already archived; unarchive remains a single-session operation.
- `deleteSession(id)` clears active runtime state and pending compact work, removes the in-memory session, detaches its channels, deletes the per-session history JSON plus any legacy frontier file, rewrites metadata/channels, and publishes deletion state.
- One Main-owned deletion orchestrator serves nonrecursive WebUI delete, `/session delete`, and model `delete_session`; WebUI alone may explicitly request recursive deletion. It preflights the complete backend-recomputed selection. Any non-WebUI channel blocker or busy local target prevents deletion; busy targets receive the existing stop/queue-clear retry outcome, while an exact Worker target uses the closed interrupt/stop/handback/fence teardown before ordinary cleanup. A bounded process-local claim stabilizes the selected subtree while preparation/deletion runs by rejecting late relation/child/move commits, channel attachments, and new queue/retry/busy starts at their mutation boundaries. Cross-session model deletion additionally admits the canonical source plus target set through one operation-specific process-local conflict guard, so reciprocal/overlapping deletes reject retryably before either later call can claim or drain the other's active source; this guard does not claim the source or block its own Worker turn completion. The orchestrator revalidates graph/channel/activity state immediately before mutation and always releases both protections. Successful recursive deletion is deepest-first. Nonrecursive deletion claims and detaches surviving direct children before deleting the root instead of risking dangling parent IDs.
- Current deletion does **not** remove SQLite archive records, archive branch metadata, vector rows/checkpoints, or independent managed/ToolScript state. Those durable sources may therefore outlive the live session record.
- While any archive branch/log/committed-alias-ledger record for a deleted lifetime remains discoverable, its exact internal session ID remains reserved. Explicit named-session creation, agent-main recreation, and internal-ID moves/renames must reject that target instead of merging generations. Agent creation without a main session remains allowed because it creates no session lifetime.
- Successful internal-ID moves commit old-to-current canonical aliases only after strict live/filesystem/archive/index/metadata/channel persistence succeeds. Known failures reverse moved state and do not reserve the uncommitted target; if any reverse write fails, the pending journal remains for startup retry. The journal explicitly records `rolling-back` or `finishing` intent plus target-agent-directory ownership, so startup follows recorded intent rather than inferring it from partially persisted metadata. SQLite rows move to the target, while the one-time legacy migration canonicalizes historical JSONL payload IDs only through proven durable aliases. Old, intermediate, and current IDs remain reserved and archive-readable; the small reservation ledger remains the independent identity recovery source.
- Agent/session move and rename operations coordinate metadata, history path, relations, attachments, archive store, and vector IDs through their dedicated façades.
- An identity move preserves the moved session's incoming `parentSessionId` when no override is supplied and rewrites direct child references from the old real ID to the target ID. The shared move façade may accept an explicit existing `parentSessionId` for intentional post-move reparenting; identity success and any later relation-write failure are reported separately rather than claiming that the committed identity move rolled back.

## Modules and units

- [session core](../modules/session-core.md)
- [session context](../modules/session-context.md)
- [message routing](../modules/message-routing.md)
- [LLM](../modules/llm.md)
- [src-session-manager](../units/src-session-manager.md)
- [src-session-deletion](../units/src-session-deletion.md)
- [src-session-agent-ops](../units/src-session-agent-ops.md)
- [src-session-metadata-store](../units/src-session-metadata-store.md)
- [src-session-history](../units/src-session-history.md)
- [src-session-layered-context](../units/src-session-layered-context.md)
- [src-session-archive-store](../units/src-session-archive-store.md)
- [image blob lifecycle](./image-blob-lifecycle.md)

## Compatibility

- Stored legacy frontier files are startup migration inputs only; current hydration reads embedded frontier state.
- Legacy busy fields remain concurrency/recovery compatibility data while `runtimeState` is current display state.
- Existing non-main child ID chains retain append-style identity.
- Existing live sessions remain hydratable when their ID also appears in the archive. Reservation checks distinguish persisted live records from archive-only deleted lifetimes.

## Design decisions

### D-lifecycle-prefix-lineage

Prompt-cache keys follow the model-facing prefix, not session identity. Forks and same-prefix side/compact-planning requests reuse the key; fresh non-fork sessions, successful compact commits, and clear operations use a fresh key.

### D-lifecycle-model-effort-inheritance

[2026-08-11] New Session lifetimes carry model and provider-neutral effort as one prospective pair. Child/fork resolution is explicit effort, parent `childEffortDefault`, parent raw `effort`, then unset; model resolution keeps the existing explicit model, parent child-model default, parent raw model, then global-default path. Inherited unset remains unset so a differently configured child model or virtual leaf chooses its own default. Fork/non-fork creation also preserves the parent's future-child defaults, source-based agent/session creation carries raw effort with model inheritance, and new-session timers snapshot model plus raw effort together. At timer fire, that persisted pair is inherited state and is re-normalized against one current models-config snapshot, preserving compatible concrete/virtual-union effort while clearing config-drift incompatibility to unset rather than rejecting delivery. Newly explicit effort remains strict against the selected concrete capability or virtual union, while stale inherited effort is cleared rather than blocking creation.

### D-lifecycle-manual-fork-event

A manual fork remains visible to the parent even with no child instruction. The parent notice is a durable session event; idle parents are not automatically triggered by the append, while busy parents queue it behind current work.

### D-lifecycle-lazy-hydration

Startup loads lightweight metadata stubs and hydrates per-session history/frontier only when a session is accessed.

### D-lifecycle-archived-id-reservation

An internal session ID identifies one lifetime while its durable archive remains retained. Identity checks use exact persisted strings; compatibility IDs are not trimmed or silently normalized. A non-reentrant process-wide lock spans reservation check through strict live commit for every supported in-process creator and internal-ID mover. Public entry points never inherit an ambient bypass token: nested work uses explicit private unlocked helpers, so asynchronous descendants from callbacks queue normally after the current owner. This is a single-master-writer boundary, not a distributed lock for multiple processes sharing one data directory. Automatic allocation skips live IDs, aliases, and archive-only IDs, including timer sessions and both guest-agent modes. Explicit creation and any move/rename that changes the internal ID reject an archive-only target with the stable `SESSION_ID_ARCHIVED` code; they never combine old archive records with a new generation. Hydration of an existing persisted live lifetime is not new allocation and remains allowed even though that same ID has archive records. Display-name and other metadata-only changes do not allocate an internal ID and do not perform this check. If an agent is deleted while its main-session archive remains, recreating the same agent main session is rejected rather than inventing a different hidden main ID.

Moved historical IDs are committed durable aliases, not only live metadata. `state/session-id-move-pending.json` exists only while a move is in progress; it validates recovery-safe IDs and semantically binds recovery intent plus any owned target-agent directory to the target session's exact agent component. For create-agent moves it is durable before directory creation or memory copy begins. `rolling-back` restores the source and removes that owned directory only after all reverse writes succeed; `finishing` commits the target and keeps it. Initialization failure removes the partial owned directory before clearing the journal; crash recovery performs the same cleanup idempotently. Pending recovery runs before ordinary session loading and any failure is fatal until a later startup can complete it. After strict move state writes succeed, `state/session-id-reservations.jsonl` atomically records old-to-current mappings and SQLite mirrors them. Bootstrap repairs syntactically malformed/missing ledger data from all nonconflicting SQLite rows and backfills proven live metadata aliases. Conflicting valid mappings and alias cycles fail closed. A pre-ledger path/payload mismatch is not move proof because legacy forks copied parent rows into child logs: both identities remain independently reserved, mismatched rows are not merged into the path identity, and no canonical alias is invented. The one-time SQLite migration maps historical payload IDs only through proven mappings. Old/intermediate aliases without a canonical live session classify as archived and resolve to the same archive reads as the current ID.

Unbound channel resolution has a separate per-channel serialization boundary. Its factory returns explicit `{ session, created }` ownership; a concurrent attachment or attach failure can destructively remove only a lifetime proven created by that invocation. It durably persists the winning attachment before returning. Explicit `/session new`, create, fork, and attach command paths await durable attachment writes rather than returning after a fire-and-forget update.

### Follow-up: attachment replacement transaction

Detach-then-attach command flows await both persistence operations but are not yet one atomic durable transaction. A failure can leave the old binding detached, but must not delete session/archive data; making replacement atomic remains an explicit follow-up.

### D-lifecycle-descendant-actions

[2026-08-01, updated 2026-08-11] Recursive WebUI archive/delete always derives descendants from the complete canonical live relation graph on the backend; presentation filtering, pinning, and frontend-provided ID lists are not lifecycle authority. Both options default off. Archive is one metadata-state update and unarchive stays nonrecursive. One operation-specific Main-owned deletion orchestrator serves nonrecursive WebUI delete, `/session delete`, and model `delete_session`; WebUI's explicit recursive mode remains a separate selection option rather than changing the default. Delete uses a process-local, non-persisted claim over the selected canonical subtree (or the root plus direct survivors for nonrecursive deletion), acquired after prior identity mutations and concrete Worker admissions drain. While claimed, normal relation/child/move commits, channel attachment, and new queue/retry/busy starts must recheck at their actual mutation boundaries and fail retryably; a Worker admission holds the same narrow identity lock only through ensure/spawn plus durable mailbox append, or through synchronous Supervisor accepted-call entry, never through provider/tool completion. Cross-session model deletion first holds a separate operation-specific, non-persisted admission over the canonical source and selected targets. An overlapping or reciprocal call fails retryably before target claim/teardown; the admission does not claim the source, obstruct the already-running source turn's response/final persistence, or expand into a generic transaction/lease. This is bounded delete coordination, not a general transaction or distributed lease. After preparation, the orchestrator revalidates the claimed graph, channel blockers, busy state, and queue state immediately before mutation and releases protections in `finally`; releasing a failed/blocked delete retriggers any retained queue on an idle survivor. Recursive deletion is deepest-first only after the subtree is stable. Nonrecursive deletion detaches the stabilized direct survivors before deleting the root. Unexpected failures report actual partial progress without inventing rollback.

A model/tool source may delete another permitted local or Worker-owned target through the fixed Main operation, but the canonical current source or any persisted alias resolving to it must fail before target preparation; no post-turn self-destruction protocol is introduced. The reverse request carries only bounded target identity. Main checks the exact source generation at ingress, before each target-owner teardown, and before every final detach/delete mutation. It never accepts a live source Session, child callback, generic mutation request, or reusable lifecycle claim over IPC.

### D-lifecycle-identity-move-relations

[2026-08-01] Session identity moves preserve the existing incoming parent when no parent option is supplied and rewrite direct child references to the new canonical ID, so individually moving every member of an existing tree preserves its topology independent of move order. An explicit `parentSessionId` is an intentional post-move override, not a requirement for ordinary tree migration. There is no recursive tree-move API. If that separate relation write fails after the journaled identity move commits, callers must report identity success plus the unconfirmed parent update instead of implying rollback.
