# Unit: src-session-runtime-state

Files: src/sessionRuntimeState.ts, src/sessionRuntimeState.test.ts

## Purpose

Provides the canonical derived runtime-state view for sessions. It combines transient in-memory active processing phases with persisted wait metadata to classify each session as `requesting-model`, `running-tool`, `waiting`, or `idle` for tools, APIs, and WebUI displays.

## Key Exports

- `SessionRuntimeState` / related type aliases — shared backend payload shape for runtime state.
- `setActiveSessionRuntimeState(sessionId, state)` — records transient active `requesting-model` or `running-tool` state and notifies session-list listeners.
- `clearActiveSessionRuntimeState(sessionId)` — clears transient active state when a session leaves active processing.
- `markSessionCatalogStub()` / `clearSessionCatalogStub()` /
  `getEffectiveSessionQueueLength()` — one non-persisted queue-count boundary
  for lightweight catalog stubs versus hydrated owners.
- `buildSessionRuntimeState(session)` — derives the canonical state from active map + `session.meta.wait` + legacy busy flags.
- `formatSessionRuntimeStateSummary(runtimeState)` — compact text label used by session status/list output.

## Function Index

| Function | Description |
|----------|-------------|
| `normalizeStringArray(value)` | Tolerant string-array reader for wait metadata. |
| `deriveWaitingDetails(session)` | Builds wait details from `session.meta.wait`, including wait-all, timeout, and wait-exec metadata. |
| `setSessionRuntimeStateUpdateCallback(callback)` | Registers the session-list update callback used by `sessionManager`. |
| `setActiveSessionRuntimeState(sessionId, state)` | Sets transient active runtime state. |
| `clearActiveSessionRuntimeState(sessionId)` | Removes transient active runtime state. |
| `markSessionCatalogStub(session, queueLength)` / `clearSessionCatalogStub(session)` | Marks or clears the lightweight catalog-stub count. |
| `getEffectiveSessionQueueLength(session)` | Selects catalog count for a marked stub and actual queue length for a hydrated owner. |
| `getActiveSessionRuntimeState(sessionId)` | Returns active state without derivation. |
| `buildSessionRuntimeState(session)` | Applies priority order: active state, persisted recognized wait, legacy busy fallback, idle; queue length remains orthogonal. |
| `formatSessionRuntimeStateSummary(runtimeState)` | Formats short labels such as `running-tool:exec 1/1`, `waiting:sessions 1/2`, or `idle`. |

## Dependencies

- `./types` — `Session` shape and queue metadata.

## Behavior

- Active `requesting-model` / `running-tool` state is transient and never persisted.
- Active tool argument previews are presentation-only and are normalized to bounded strings at the runtime-state setter, so an invalid caller value cannot escape into a strict Session-worker projection.
- Persisted `session.meta.wait` drives `waiting` after the active turn has ended only when the wait has an explicit UI-visible target/reason.
- `waitAll.sessions` derives `waitingFor: 'sessions'` with satisfied and pending lists, and takes display precedence if combined with advisory exec ids.
- Runtime-state waiting details distinguish `all-sessions`, `any-session`, `exec`, `input`, and `fallback`; the corresponding bounded target/source fields remain presentation-only projections of authoritative per-Session wait state.
- Legacy bare/reason-only waits remain readable and derive no current waiting detail. Current model-facing calls cannot create them.
- If a legacy/stale session is `busy` but no active transient state exists, the builder falls back to `requesting-model` with `active.phase: 'unknown'` so old payloads do not appear idle.
- A lightweight startup stub uses its catalog queue count in both the top-level
  DTO and derived state. A hydrated owner always uses its actual queue; clearing
  the stub marker prevents stale synthetic counts from overriding authority.
  Queued work without another active phase remains canonical `idle` with
  `busy:false` while retaining the positive queue count. Queue presence alone
  does not imply that a provider request or tool is executing.
- Lightweight startup stubs also carry only the catalog's sanitized wait
  presentation, which is sufficient to render timer, wait-all, and exec waits.
  Authority hydration and Worker handback replace `meta.wait` with exact
  authority state while clearing the shared catalog-stub marker; Worker
  projections overlay their exact runtime state directly.

## Integration

- `sessionManager` re-exports the builder and active-state setters, includes `runtimeState` in `listSessions()`, and fans state changes out through independent global-list and targeted per-session callbacks for WebUI SSE consumers.
- `messageRouter` sets `requesting-model` around LLM calls and `running-tool` around tool execution, then clears active state when session processing ends.
- `sessionStatus` and WebUI `/api/sessions` expose the derived payload while preserving legacy `busy` / `busyStartedAt` / `queueLength` fields.

## Design Decisions

- [2026-08-26, updated 2026-08-27] Canonical runtime state retains four top-level states while current waits expose five source kinds. Successful `afterSend:"wait"` records the resolved target as non-filtering `waitAnySessions` metadata; `afterSend:"finish"` creates no wait and leaves the completed Session idle.
- [2026-08-10, updated 2026-08-11] Queue count has one effective derivation: catalog count only for a marked lightweight stub, actual queue length for a hydrated owner, and Worker projection count after overlay. Queue count is activity-independent: with no transient active phase, no recognized persisted wait, and `busy:false`, positive queued work is canonical `idle`/`busy:false` with its real queue count. It must not fabricate `requesting-model`, thinking/Stop UI, active sidebar treatment, or an idle notification transition. A real legacy `session.busy:true` without transient phase still falls back to `requesting-model`.
- Strict Session-worker publication and malformed-tool recovery are canonical in [D-process-topology-session-events](../threads/process-topology-and-rpc.md#d-process-topology-session-events).
