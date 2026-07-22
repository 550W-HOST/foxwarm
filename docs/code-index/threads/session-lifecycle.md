# Thread: session lifecycle

## Overview

Cross-module lifecycle from public creation through lazy hydration, queued execution, compaction/archive lineage, parent-child/fork behavior, restart recovery, archival, and coordinated deletion.

## Creation surfaces

- `createEmptySession(sessionId?)` is the simple public façade. It returns an existing session when present or lazily creates/saves an empty one and reports `{ session, created }`.
- `createSessionInAgent(options)` is the agent-aware public creation surface for a named session with display/node/model/parent/prompt-file options.
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
5. The shared metadata file remains a presentation/list index; per-session history owns messages, prompt snapshot/cache key, and frontier.
6. Creation-critical history and metadata writes propagate errors. A known failed creation removes its map/history/archive artifacts so the same uncommitted ID can be retried; ordinary noncritical saves retain best-effort logging behavior.

Canonical data authority: [D-session-core-authoritative-history](../modules/session-core.md#d-session-core-authoritative-history).

## Active turn and restart

- Queue insertion and persisted wait-state transitions live behind the session façade.
- `MessageRouter.processSessionQueue()` claims the session and runs the provider/tool loop; session core does not own that loop.
- `resumeBusySessions()` inspects metadata-only busy/queued/managed-inbox state. It clears stale busy fields and appends or deduplicates a restart event, retriggers queued work, and reclaims or wakes persisted managed inboxes/controllers.

Canonical turn flow: [message processing pipeline](./message-processing-pipeline.md).

## Context, archive, and recall

- Final usage may trigger `checkAndCompactIfNeeded`.
- Compaction plans against a snapshot and commits only a compatible consumed prefix.
- Frontier rendering uses `renderHistoryFromFrontier`.
- Current archive appends write JSONL plus SQLite; effective reads enforce fork lineage caps; vector indexing may lag without losing source data.

Canonical contract: [context compaction and recall](./context-compaction-and-recall.md), especially [dual archive](./context-compaction-and-recall.md#d-context-dual-archive).

## Child and fork lifecycle

- Agent-main children replace the `main` leaf; non-main children retain append-style IDs.
- Fork and child allocators skip both live and archived IDs while incrementing their suffix counters.
- Forks copy the model-visible prefix/frontier/snapshot and inherit prompt-cache/archive lineage only through the fork point.
- Non-fork children start a fresh model-visible prefix and cache key.
- A manual user fork calls `notifyManualForkCreated` so the parent history records the child even when no initial instruction was supplied.

## Manual-fork event

`notifyManualForkCreated(parentSessionId, childSessionId, initialMessage?)` creates a user-role structured session event:

- metadata uses `kind="session-event"`, `event="manual-fork-created"`, current parent ID, child ID, and `(none)` when there is no initial message;
- an idle parent receives an appended durable history message with goal-reminder suppression and is not triggered merely by that append;
- a busy parent receives the same notification as a background queue item;
- an initial instruction, when supplied, is queued to the child by the fork command path independently of this parent notice.

## Archive and deletion

- `archiveSession(id, archived)` is a presentation/lifecycle flag, not physical deletion.
- `deleteSession(id)` clears active runtime state and pending compact work, removes the in-memory session, detaches its channels, deletes the per-session history JSON plus any legacy frontier file, rewrites metadata/channels, and publishes deletion state.
- Current deletion does **not** remove archive JSONL/SQLite records, archive branch metadata, vector rows/checkpoints, or independent managed/ToolScript state. Those durable sources may therefore outlive the live session record.
- While any archive branch/log/committed-alias-ledger record for a deleted lifetime remains discoverable, its exact internal session ID remains reserved. Explicit named-session creation, agent-main recreation, and internal-ID moves/renames must reject that target instead of merging generations. Agent creation without a main session remains allowed because it creates no session lifetime.
- Successful internal-ID moves commit old-to-current canonical aliases only after strict live/filesystem/archive/index/metadata/channel persistence succeeds. Known failures reverse moved state and do not reserve the uncommitted target; if any reverse write fails, the pending journal remains for startup retry. The journal explicitly records `rolling-back` or `finishing` intent plus target-agent-directory ownership, so startup follows recorded intent rather than inferring it from partially persisted metadata. SQLite rows move to the target, while bootstrap canonicalizes historical JSONL payload IDs only through proven durable aliases so old, intermediate, and current IDs remain reserved and archive-readable after restart or SQLite rebuild.
- Agent/session move and rename operations coordinate metadata, history path, relations, attachments, archive store, and vector IDs through their dedicated façades.

## Modules and units

- [session core](../modules/session-core.md)
- [session context](../modules/session-context.md)
- [message routing](../modules/message-routing.md)
- [LLM](../modules/llm.md)
- [src-session-manager](../units/src-session-manager.md)
- [src-session-agent-ops](../units/src-session-agent-ops.md)
- [src-session-metadata-store](../units/src-session-metadata-store.md)
- [src-session-history](../units/src-session-history.md)
- [src-session-layered-context](../units/src-session-layered-context.md)
- [src-session-archive-store](../units/src-session-archive-store.md)

## Compatibility

- Stored legacy frontier files are startup migration inputs only; current hydration reads embedded frontier state.
- Legacy busy fields remain concurrency/recovery compatibility data while `runtimeState` is current display state.
- Existing non-main child ID chains retain append-style identity.
- Existing live sessions remain hydratable when their ID also appears in the archive. Reservation checks distinguish persisted live records from archive-only deleted lifetimes.

## Design decisions

### D-lifecycle-prefix-lineage

Prompt-cache keys follow the model-facing prefix, not session identity. Forks and same-prefix side/compact-planning requests reuse the key; fresh non-fork sessions, successful compact commits, and clear operations use a fresh key.

### D-lifecycle-manual-fork-event

A manual fork remains visible to the parent even with no child instruction. The parent notice is a durable session event; idle parents are not automatically triggered by the append, while busy parents queue it behind current work.

### D-lifecycle-lazy-hydration

Startup loads lightweight metadata stubs and hydrates per-session history/frontier only when a session is accessed.

### D-lifecycle-archived-id-reservation

An internal session ID identifies one lifetime while its durable archive remains retained. Identity checks use exact persisted strings; compatibility IDs are not trimmed or silently normalized. A non-reentrant process-wide lock spans reservation check through strict live commit for every supported in-process creator and internal-ID mover. Public entry points never inherit an ambient bypass token: nested work uses explicit private unlocked helpers, so asynchronous descendants from callbacks queue normally after the current owner. This is a single-master-writer boundary, not a distributed lock for multiple processes sharing one data directory. Automatic allocation skips live IDs, aliases, and archive-only IDs, including timer sessions and both guest-agent modes. Explicit creation and any move/rename that changes the internal ID reject an archive-only target with the stable `SESSION_ID_ARCHIVED` code; they never combine old archive records with a new generation. Hydration of an existing persisted live lifetime is not new allocation and remains allowed even though that same ID has archive records. Display-name and other metadata-only changes do not allocate an internal ID and do not perform this check. If an agent is deleted while its main-session archive remains, recreating the same agent main session is rejected rather than inventing a different hidden main ID.

Moved historical IDs are committed durable aliases, not only live metadata. `state/session-id-move-pending.json` exists only while a move is in progress; it validates recovery-safe IDs and semantically binds recovery intent plus any owned target-agent directory to the target session's exact agent component. For create-agent moves it is durable before directory creation or memory copy begins. `rolling-back` restores the source and removes that owned directory only after all reverse writes succeed; `finishing` commits the target and keeps it. Initialization failure removes the partial owned directory before clearing the journal; crash recovery performs the same cleanup idempotently. Pending recovery runs before ordinary session loading and any failure is fatal until a later startup can complete it. After strict move state writes succeed, `state/session-id-reservations.jsonl` atomically records old-to-current mappings and SQLite mirrors them. Bootstrap repairs syntactically malformed/missing ledger data from all nonconflicting SQLite rows and backfills proven live metadata aliases. Conflicting valid mappings and alias cycles fail closed. A pre-ledger path/payload mismatch is not move proof because legacy forks copied parent rows into child logs: both identities remain independently reserved, mismatched rows are not merged into the path identity, and no canonical alias is invented. SQLite rebuild maps historical payload IDs only through proven mappings. Old/intermediate aliases without a canonical live session classify as archived and resolve to the same archive reads as the current ID.

Unbound channel resolution has a separate per-channel serialization boundary. Its factory returns explicit `{ session, created }` ownership; a concurrent attachment or attach failure can destructively remove only a lifetime proven created by that invocation. It durably persists the winning attachment before returning. Explicit `/session new`, create, fork, and attach command paths await durable attachment writes rather than returning after a fire-and-forget update.

### Follow-up: attachment replacement transaction

Detach-then-attach command flows await both persistence operations but are not yet one atomic durable transaction. A failure can leave the old binding detached, but must not delete session/archive data; making replacement atomic remains an explicit follow-up.
