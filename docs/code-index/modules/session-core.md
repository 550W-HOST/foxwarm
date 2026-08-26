# Module: session core

## Responsibility

Session core owns durable session/agent lifecycle, the queue and wait boundary, metadata/history persistence, parent-child relations, channel attachments, managed-session leases, goals, and canonical runtime state. `src/sessionManager.ts` remains the live-object integration façade over smaller `src/session/*` domains. `SessionRuntime` is the asynchronous immutable-DTO boundary for external session queries, commands, and update events; it delegates to the manager in local placement and routes supported semantic operations to the exact owner when Session-worker placement is enabled.

The live LLM/tool turn loop belongs to the `SessionTurnRunner` reached through `MessageRouter.processSessionQueue()`. Session core stores and triggers work; message routing claims it and executes the turn. Canonical flow: [message processing pipeline](../threads/message-processing-pipeline.md).

Cross-module creation, hydration, fork/cache lineage, restart, archive, and deletion: [session lifecycle](../threads/session-lifecycle.md).

Main-owned identity/topology/list storage and indexed access: [Main catalog storage and indexed queries](../threads/main-catalog-storage-and-indexed-queries.md).

Canonical image references in live history, queues, archives, and forks are owned by [image blob lifecycle](../threads/image-blob-lifecycle.md).

## Units

- [src-session-manager](../units/src-session-manager.md) — façade, in-memory map, lazy hydration, queue/wait coordination, callbacks, and restart recovery.
- [src-session-deletion](../units/src-session-deletion.md) — shared Main-owned WebUI/command/model deletion orchestration, claims, blocker/revalidation flow, child detachment, and Worker target teardown composition.
- [src-session-runtime](../units/src-session-runtime.md) — placement-neutral high-level DTO service/facade for external session queries, commands, settings, controls, and events.
- [src-session-worker-runtime](../units/src-session-worker-runtime.md) — activated configurable process-generation/mailbox fencing, authoritative state coordination, exact-owner operations, and supervised per-session child lifecycle.
- [src-session-runtime-state](../units/src-session-runtime-state.md) — `requesting-model`, `running-tool`, `waiting`, and `idle` derivation.
- [src-session-metadata-store](../units/src-session-metadata-store.md) — shared metadata index, per-session history snapshots, rebuild, and durable writes.
- [src-session-catalog-store](../units/src-session-catalog-store.md) — Main-owned SQLite Session catalog, strict migration, row/batch writes, indexed queries, and counts.
- [src-session-channels](../units/src-session-channels.md) — persisted channel attachments, direct delivery, and session broadcasts.
- [src-session-agent-ops](../units/src-session-agent-ops.md) — agent creation, inheritance/isolation metadata, moves, and snapshot refresh.
- [src-session-misc](../units/src-session-misc.md) — archive append helpers, relations, message visibility, snapshot refresh, and child reminders.
- [src-managed-sessions](../units/src-managed-sessions.md) — exclusive leases, inbox interception, step execution, and controller wakeup.
- [src-session-goal](../units/src-session-goal.md) — long-horizon goal persistence and bounded reminders.

Active history transformation, compaction, archive-store, and vector retrieval are owned by [session context](./session-context.md).

## Public interfaces

- `getSession`, `getExistingSession`, `createEmptySession`, `createSession`, `deleteSession`, `archiveSession`, `saveSession`, `listSessions`.
- `enqueueSessionItem` and typed queue-event helpers.
- `startSessionWait`, stop/dequeue/retry controls, and router-trigger registration.
- `forkSession`, `createChildSession`, `setSessionParent`, `sendToSession`.
- Agent creation, inheritance/isolation, session move, and snapshot-refresh operations.
- Channel attachment, direct channel/file delivery, and session broadcast creation.
- Managed-session open/step/release operations.
- Goal set/clear/reminder operations.
- Runtime-state builders and independent history/event/list/state callbacks.
- `SessionRuntime` list/state/history projections, enqueue/event/settings/control commands, and immutable update events for external consumers.

## Data ownership

- `state/catalog.sqlite` is the Main-owned identity/topology/list projection. Its cross-module admission rule is canonical in [D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).
- `state/sessions/<id>.json` owns versioned authoritative full semantic session state: durable history, queue, wait/managed metadata, the optional child-handoff reminder boundary, prompt snapshot/cache key, message provenance, settings, and worker mailbox cursor. Unversioned legacy files receive a one-time tolerant upgrade; current-version hydration replaces semantic fields rather than merging stale catalog values. Per-session files use durable serialized replacement without numbered rotation.
- `state/channels.json` owns channel attachments.
- `state/session-runtime.sqlite` owns Session-worker generations, incarnations, mailbox intents, and acknowledged mailbox cursors when process placement is enabled; it never owns semantic Session state.
- `state/sessions/<id>.json` additionally persists `lastAppliedMailboxId`; worker placement must durably replace this authoritative file before SQLite acknowledges the corresponding ordered session-local mailbox prefix.
- Agent metadata is separate from session history.
- Active model/tool phases are in memory; wait metadata is persisted on the session.

The durable JSON implementation and backup semantics are canonical in [src-utils](../units/src-utils.md#d-disk-json-durability).

## Invariants

- Queue processing is serialized per session. `busy` remains the concurrency/recovery flag, while `runtimeState` is the canonical display phase.
- Per-session JSON is authoritative for semantic state. Catalog-only presentation fields are not inferred from authority files when the catalog is missing.
- A managed session has at most one live lease. Input addressed to an actively managed target enters its managed inbox.
- When either side is isolated, inter-session delivery requires the same session or an explicit direct parent/child relation; unrelated and sibling sessions are denied.
- Fork lineage never exposes parent content created after the fork point.
- Atomic in-process creation skips live/archived exact internal IDs, explicit creation rejects archive-only reuse, and per-channel first-message resolution converges on one attached lifetime while persisted live sessions still hydrate. Canonical contract: [archived ID reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
- Channel mutations are persisted after the in-memory map changes.
- Goal reminders advance their sequence anchor when emitted so the same boundary is not repeated.
- External callers on the SessionRuntime seam receive cloned DTOs; no returned projection, history item, queue item, or event payload is a remotely dereferenceable live `Session` object.

## Compatibility

- APIs may retain `busy`, `busyStartedAt`, and queue-length fields while current clients use `runtimeState`.
- Stored channel bindings normalize legacy `push-only` to `send-only` and the old allow-all-group-members field to the current allow-all-users field.
- Existing non-main child ID chains retain append-style IDs.
- Legacy frontier migration is documented by [session context](./session-context.md#compatibility).

## Design decisions

### D-session-core-facade

`src/sessionManager.ts` is a stable façade, not the owner of every session implementation. Domain logic belongs in `src/session/*`, and live turn execution belongs in `SessionTurnRunner` behind `MessageRouter` ingress.

### D-session-core-authoritative-history

Per-session JSON is authoritative for full semantic Session state. The Main-owned catalog may contain UI-only fields intentionally excluded from semantic state. Catalog storage and scaling are canonical in [D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary); cross-process save-before-mailbox-ack ordering is canonical in [D-process-topology-session-state-authority](../threads/process-topology-and-rpc.md#d-process-topology-session-state-authority).

### D-session-core-runtime-state

Active provider/tool phases are transient. Wait state persists. Legacy busy fields remain compatibility/concurrency data rather than the display taxonomy.

### D-session-core-isolated-relations

Explicit direct parent/child relations are the only cross-agent inter-session exception when either side is isolated. This exception does not grant tool, filesystem, or node permissions.

### D-session-core-child-identity

Agent-main child creation replaces the `main` leaf; non-main child chains retain append-style IDs. Fork state inheritance and ID construction are separate concerns.

## Open questions

- None recorded for the current session-core boundary. Cross-module context and turn-loop questions belong to their canonical threads.
