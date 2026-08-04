# Unit: src-session-runtime

Files: src/sessionRuntime.ts, src/sessionRuntimeService.ts, src/sessionRuntimeService.test.ts

## Purpose

Defines the high-level asynchronous SessionRuntime service contract used at external session boundaries. Local placement delegates to `sessionManager`, but requests, replies, errors, and events cross the same cloned DTO boundary expected by a future child placement. It never returns a live `Session` reference.

## Key exports

- `sessionRuntimeServiceDescriptor` — versioned request/event descriptor.
- `createSessionRuntimeServiceHandler()` — local authoritative handler over current session-manager operations.
- `initializeSessionRuntime()` / `shutdownSessionRuntime()` — local service lifecycle and bounded drain.
- `listSessions()`, `getSession()`, `getHistory()` — immutable projections.
- `enqueue()`, `queueEvent()`, `updateSettings()`, `control()` — high-level mutation commands.
- `startEvents()`, `subscribe()` — cloned history/list/state event publication.
- `assertSessionWorkerPlacementSupported()` / `getSessionRuntimeStatus()` — explicit current placement capability/status.

## Contract groups

- **Queries:** bounded list/state projections and full canonical history/queue snapshot for WebUI bootstrap.
- **Queue commands:** canonical `QueueItem` enqueue and typed background/trigger/onboot event insertion.
- **Settings:** model, child model, cwd, node, display name, and compact-threshold updates in one persisted command.
- **Controls:** stop, dequeue, and retry with existing session-manager/router semantics.
- **Events:** ordered history, list, and targeted state updates cloned from session-manager callbacks.

## Behavior and invariants

- The local transport structured-clones inputs, outputs, event payloads, and serialized error details. Callers cannot mutate handler-owned history, queue, or session fields through returned DTOs.
- History reads externalize legacy image payloads. If live history changes while asynchronous canonicalization is running, the query fails retryably with `SESSION_HISTORY_CHANGED` instead of replacing concurrent history.
- Queue insertion still passes through the manager's wait/managed-inbox transition and router trigger. SessionRuntime does not create another queue or turn owner.
- Settings validate every supplied field before mutating the live session, persist once, and return previous/current projections.
- Event publication binds to the existing independent manager callbacks and preserves callback order through the RPC event queue.
- `sessionWorkers:false` uses this local service. `sessionWorkers:true` throws `SESSION_WORKERS_NOT_IMPLEMENTED`; child process, mailbox, snapshot generation, ownership fencing, wake, and idle release are not simulated by the local facade.
- Shutdown first stops event publication, then drains the local RPC transport so no new command is accepted during process teardown.

## Integration

- WebUI list/state/history/settings routes and SSE bootstrap/update delivery consume this service.
- `MessageRouter.handleIncomingMessage()` uses its enqueue command; the router's owned turn loop stays live-object local.
- Commands and tools use settings/control/query methods for migrated external operations.
- `src/index.ts` initializes the service after session loading and stops it before vector shutdown.

## Canonical ownership

Process placement, future worker ownership, and current child-placement limitations are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md).