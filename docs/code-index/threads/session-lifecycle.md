# Thread: session lifecycle

## Overview

Cross-module lifecycle from public creation through lazy hydration, queued execution, compaction/archive lineage, parent-child/fork behavior, restart recovery, archival, and coordinated deletion.

## Creation surfaces

- `createEmptySession(sessionId?)` is the simple public façade. It returns an existing session when present or lazily creates/saves an empty one and reports `{ session, created }`.
- `createSessionInAgent(options)` is the agent-aware public creation surface for a named session with display/node/model/parent/prompt-file options.
- `createAgentWithMainSession(options)` owns agent creation plus optional main session.
- Low-level `createSession(sessionId, sessionData)` accepts a fully constructed session object, ensures its prompt-cache key, installs it in the map, and saves it. It does **not** allocate an ID from an options object.
- `forkSession` and `createChildSession(parentSessionId, suffix, fork, options)` own fork/non-fork child creation.

Canonical façade and child-ID ownership: [session core façade](../modules/session-core.md#d-session-core-facade) and [child identity](../modules/session-core.md#d-session-core-child-identity).

## Persistence and hydration

1. Startup migrations run before normal loading.
2. `loadSessions()` loads the metadata index, creates lightweight session objects, and loads channel attachments.
3. `getSession(id)` lazily loads the authoritative per-session history snapshot.
4. When an embedded `contextFrontier` exists, hydration calls `renderHistoryFromFrontier(session)` or annotates an already matching rendered history.
5. The shared metadata file remains a presentation/list index; per-session history owns messages, prompt snapshot/cache key, and frontier.

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

## Design decisions

### D-lifecycle-prefix-lineage

Prompt-cache keys follow the model-facing prefix, not session identity. Forks and same-prefix side/compact-planning requests reuse the key; fresh non-fork sessions, successful compact commits, and clear operations use a fresh key.

### D-lifecycle-manual-fork-event

A manual fork remains visible to the parent even with no child instruction. The parent notice is a durable session event; idle parents are not automatically triggered by the append, while busy parents queue it behind current work.

### D-lifecycle-lazy-hydration

Startup loads lightweight metadata stubs and hydrates per-session history/frontier only when a session is accessed.
