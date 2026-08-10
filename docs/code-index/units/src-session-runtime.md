# Unit: src-session-runtime

Files: src/sessionRuntime.ts, src/sessionRuntimeService.ts, src/sessionWorkerSnapshot.ts, src/sessionRuntimeService.test.ts

Secondary files: src/sessionWorkerIngress.ts, src/sessionWorkerSupervisor.ts, src/sessionWorkerRuntimeService.ts, src/sessionWorkerSourceContextRegistry.ts, src/sessionWorkerIngress.test.ts, src/sessionWorkerEnsureIngress.test.ts

## Purpose

Defines the high-level asynchronous SessionRuntime service contract used at external session boundaries. Local placement delegates to `sessionManager`, but requests, replies, errors, and events cross the same cloned DTO boundary expected by a future child placement. It never returns a live `Session` reference.

## Key exports

- `sessionRuntimeServiceDescriptor` — version-5 request/event descriptor.
- `createSessionRuntimeServiceHandler()` — local authoritative handler over current session-manager operations.
- `initializeSessionRuntime()` / `shutdownSessionRuntime()` — local service lifecycle and bounded drain.
- `listSessions()`, `getSession()`, `getHistory()` — immutable local or exact current-Worker projections/snapshots; list requests carry SQL-backed `limit`/`offset` and return a maintained total.
- `getSessionListProjections()` — bounded by-ID projection batch plus optional
  active local/current-Worker union using one ownership query and an in-memory
  presentation revision for WebUI keyset invalidation. Its optional
  `currentOwnersOnly` mode omits requested stale/missing Worker ownership so
  Main can reconcile catalog activity without treating stale projections as busy.
- `enqueue()`, `queueEvent()`, `updateSettings()`, `control()` — high-level mutation commands.
- `submitAndRun()` — closed ensure-or-spawn Worker ingress; registers one ephemeral full-source context, ensures or spawns the exact Worker owner, submits one durable mailbox item, and returns bounded committed completion.
- `requestCompaction()` — placement-aware compaction request; local placement keeps SessionManager behavior, while an exact idle Worker uses one awaited fixed forward operation and never a mailbox item.
- `deleteMessages()`, `clearHistory()`, `forceIndex()`, `refreshSnapshot()`, `notifyManualForkCreated()` — typed exact-owner operations used by normal command/WebUI/lifecycle paths without Main authority hydration.
- `normalizeSessionWorkerIngressRequest()` — fixed exact-key/plain-data request and QueueItem normalizer with a 1 MiB serialized bound; only its rebuilt clone may reach coordination/storage.
- `startEvents()`, `subscribe()` — cloned history/list/state event publication.
- `assertSessionWorkerPlacementSupported()` / `getSessionRuntimeStatus()` — explicit current placement capability/status.

## Contract groups

- **Queries:** bounded list/state projections and full canonical history/queue snapshot for WebUI bootstrap.
- **Queue commands:** canonical `QueueItem` enqueue and typed background/trigger/onboot event insertion.
- **Settings:** worker-owned model, child model, cwd, node, verbose, and compact-threshold updates use the exact Session owner; display name is a Main-owned catalog/presentation update and is never persisted through Worker authority.
- **Controls:** stop uses the closed supervisor/Worker interrupt path. The internal `retry` action backing public Continue ensures the exact Worker owner and runs the canonical continuation turn (`parts:null`) directly inside that owner, with an optional serialized QueueSource registered against the live Main channel context for ordinary final-delivery parity; it creates no second queue/mailbox intent, and the exact runner rejects completed/waiting history before claiming busy. For the current call, only transport unavailable/send-failed/closed loss is normalized to `SESSION_WORKER_RETRY_OUTCOME_UNKNOWN`: continuation may already be committed/delivered, so callers warn and require a history check rather than claiming failure or running it automatically again. Serialized handler `RPC_CANCELLED` and `RPC_DEADLINE_EXCEEDED` remain definite; the call does not currently supply a caller signal or deadline. Dequeue remains unsupported for worker-fenced sessions. Local placement retains existing semantics.
- **Events:** ordered history, list, and targeted state updates cloned from session-manager callbacks; Worker-aware state events always overlay the exact current projection rather than emitting stale semantic fields from the Main stub.

## Behavior and invariants

- The local transport structured-clones inputs, outputs, event payloads, and serialized error details. Callers cannot mutate handler-owned history, queue, or session fields through returned DTOs.
- History reads externalize legacy image payloads. If live history changes while asynchronous canonicalization is running, the query fails retryably with `SESSION_HISTORY_CHANGED` instead of replacing concurrent history.
- Queue insertion still passes through the manager's wait/managed-inbox transition and router trigger. SessionRuntime does not create another queue or turn owner.
- Settings validate every supplied field before mutating the live session, persist once, and return previous/current projections.
- Event publication binds to the existing independent manager callbacks and preserves callback order through the RPC event queue.
- Requested IDs and aliases are first resolved to a canonical ID from already-loaded catalog identity only; cache-only, removed, or duplicate aliases remain unresolved and cannot select a Worker or trigger semantic hydration through the Worker-aware view. When exact noninactive Worker store ownership and a populated, non-stale current registry generation/incarnation agree, get/list overlay only projection-owned committed fields onto the Main catalog/presentation DTO without mutating its Session or writing semantic authority. Stale, cleared, inactive, or released registry entries never overlay or enter a volatile candidate union. Exact get/history fails retryably when noninactive ownership has no matching populated registry entry, while bounded list presentation retains the catalog-only stub without claiming Worker authority.
- Before a Session-semantic Worker operation, `ensureWorkerOwner` ensures/spawns the exact owner and, when that generation has no committed projection yet, invokes the fixed `loadProjection` operation. The Worker loads/upgrades authority and publishes one complete projection even when there is no mailbox work; an already-loaded busy owner reuses its current committed projection rather than blocking a read behind the active turn. Main never treats mere process activation as semantic readiness. Unknown catalog IDs fail before spawn.
- Worker-owned history reads one atomic per-session JSON file directly after that exact-owner load, replaces a detached read-only owner with the current state format while preserving catalog-owned identity/topology fields from the Main stub, renders/annotates its frontier, and externalizes the returned snapshot. Missing, malformed, or unsupported authority fails retryably without backup recovery or catalog fallback; legacy upgrade remains Worker-owned.
- Current Worker projection publication emits the existing state event and emits a list event only when list-visible projected fields change. No history body enters projection/SSE; WebUI uses message-count state changes to coalesce an exact history refresh. Main-owned display-name changes update catalog metadata directly, emit list/state refreshes with projection overlay, and never enter Worker authority.
- Worker registry callbacks reuse one effective list-visible overlay signature.
  Only fallback↔live transitions or changed visible fields advance the bounded
  presentation revision and list event; establish without projection,
  list-identical/non-list-only publication, and clear after stale are stable.
  Live→stale invalidates synchronously once before eventual exit/handback.
- `sessionWorkers:false` uses this local service with local placement. `sessionWorkers:true` assembles the Worker foundation at startup and injects the ingress coordinator; the `submitAndRun` operation ensures or spawns the exact Worker owner and never falls back locally.
- Session lists obtain ordered ID pages and totals from the Main catalog repository, then overlay current Worker projections only for those selected IDs. The catalog query boundary is canonical in [D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).
- Worker ingress accepts only an exact canonical ID for an actually loaded catalog session plus a current ordinary QueueItem, preserves its normalized message/source/blob-reference/image/client identities in one mailbox intent, requires one already-ready durable/live generation before append, and calls only that generation's existing `runPending`. A fixed descriptor-aware exact-key plain-data validator and nonhydrating catalog-existence preflight run before ownership, mailbox, ensure, or child-process effects and cap the normalized UTF-8 item at 1 MiB; malformed, accessor, cyclic, nonfinite, unknown-session, and overbound input never reaches the store. Current `systemPayload:true` retains the shared predicate semantics and requires a text part, while false/absent does not reclassify ordinary system parts. Post-append failure stays durable/ambiguous. Its source-context registry is Main-memory-only, full-QueueSource-keyed, ambiguity rejecting, and cleaned in `finally`. Manual-fork notification admission uses the current committed projection: busy queues the existing background message for safe-point ingestion, while committed-idle performs the typed exact-owner append without starting a turn; an idle-to-busy transition after that snapshot follows exact-owner serialization rather than introducing a second claim protocol.
- Worker compaction selection requires a current committed projection, exact ready ownership, idle/empty state, and zero prior active Supervisor calls. The Worker repeats the idle check after serialized admission and returns only after authoritative JSON plus full projection; tool-noise compaction is explicitly unavailable rather than falling back to Main.
- Local compaction admission classifies authoritative empty history before calling either layered or tool-noise compaction, preserving the exact `History is empty.` command response with no prompt-cache/persistence/index side effect. Worker selection never uses the Main catalog stub's history for this check.
- Shutdown first stops event publication, then drains the local RPC transport so no new command is accepted during process teardown.

## Integration

- WebUI list/state/history/settings routes and SSE bootstrap/update delivery consume this service.
- `MessageRouter.handleIncomingMessage()` uses its enqueue command; the router's owned turn loop stays live-object local.
- Commands and tools use settings/control/query methods for migrated external operations.
- `src/index.ts` initializes the service after session loading and stops it before vector shutdown.

## Canonical ownership

Process placement, future worker ownership, and current child-placement limitations are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md).