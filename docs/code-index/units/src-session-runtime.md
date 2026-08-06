# Unit: src-session-runtime

Files: src/sessionRuntime.ts, src/sessionRuntimeService.ts, src/sessionWorkerSnapshot.ts, src/sessionRuntimeService.test.ts

Secondary files: src/sessionWorkerIngress.ts, src/sessionWorkerSourceContextRegistry.ts, src/sessionWorkerIngress.test.ts

## Purpose

Defines the high-level asynchronous SessionRuntime service contract used at external session boundaries. Local placement delegates to `sessionManager`, but requests, replies, errors, and events cross the same cloned DTO boundary expected by a future child placement. It never returns a live `Session` reference.

## Key exports

- `sessionRuntimeServiceDescriptor` — versioned request/event descriptor.
- `createSessionRuntimeServiceHandler()` — local authoritative handler over current session-manager operations.
- `initializeSessionRuntime()` / `shutdownSessionRuntime()` — local service lifecycle and bounded drain.
- `listSessions()`, `getSession()`, `getHistory()` — immutable local or exact current-Worker projections/snapshots.
- `enqueue()`, `queueEvent()`, `updateSettings()`, `control()` — high-level mutation commands.
- `submitAndRun()` — exact already-activated Worker ingress; registers one ephemeral full-source context, submits one durable mailbox item, and returns bounded committed completion.
- `normalizeSessionWorkerIngressRequest()` — fixed exact-key/plain-data request and QueueItem normalizer with a 1 MiB serialized bound; only its rebuilt clone may reach coordination/storage.
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
- Requested IDs and aliases are first resolved to a canonical ID from already-loaded catalog identity only; cache-only, removed, or duplicate aliases remain unresolved and cannot select a Worker or trigger semantic hydration through the Worker-aware view. When exact noninactive Worker store ownership and a populated current registry generation/incarnation agree, get/list overlay only projection-owned committed fields onto the Main catalog/presentation DTO without mutating its Session or writing `sessions.json`. A stale current-generation projection remains last-known presentation; an inactive/released ownership ignores the old registry entry. Exact get/history fails retryably when noninactive ownership has no matching populated registry entry, while bounded list presentation retains the catalog-only stub without claiming Worker authority.
- Worker-owned history reads one atomic per-session JSON file directly, replaces a detached read-only owner with the current state format, renders/annotates its frontier, and externalizes the returned snapshot. Missing, malformed, legacy, or unsupported authority fails retryably without backup recovery, catalog fallback, migration, or authority rewrite.
- Current Worker projection publication emits the existing state event and emits a list event only when list-visible projected fields change. No history body enters projection/SSE; WebUI uses message-count state changes to coalesce an exact history refresh.
- `sessionWorkers:false` uses this local service. `sessionWorkers:true` still throws `SESSION_WORKERS_NOT_IMPLEMENTED`; the new `submitAndRun` operation is available only when an explicit Worker ingress coordinator is injected and does not activate, spawn, choose placement, or fall back locally.
- Worker ingress accepts only an exact canonical ID and current ordinary QueueItem, preserves its normalized message/source/blob-reference/image/client identities in one mailbox intent, requires one already-ready durable/live generation before append, and calls only that generation's existing `runPending`. A fixed descriptor-aware exact-key plain-data validator runs before Stage 2 source normalization, registry, coordinator, or store use and caps the normalized UTF-8 item at 1 MiB; malformed, accessor, cyclic, nonfinite, unknown, and overbound input never reaches the mailbox. Current `systemPayload:true` retains the shared predicate semantics and requires a text part, while false/absent does not reclassify ordinary system parts. Post-append failure stays durable/ambiguous. Its source-context registry is Main-memory-only, full-QueueSource-keyed, ambiguity rejecting, and cleaned in `finally`.
- Shutdown first stops event publication, then drains the local RPC transport so no new command is accepted during process teardown.

## Integration

- WebUI list/state/history/settings routes and SSE bootstrap/update delivery consume this service.
- `MessageRouter.handleIncomingMessage()` uses its enqueue command; the router's owned turn loop stays live-object local.
- Commands and tools use settings/control/query methods for migrated external operations.
- `src/index.ts` initializes the service after session loading and stops it before vector shutdown.

## Canonical ownership

Process placement, future worker ownership, and current child-placement limitations are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md).