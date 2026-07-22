# Unit: src-session-runtime-state

Files: src/sessionRuntimeState.ts, src/sessionRuntimeState.test.ts

## Purpose

Provides the canonical derived runtime-state view for sessions. It combines transient in-memory active processing phases with persisted wait metadata to classify each session as `requesting-model`, `running-tool`, `waiting`, or `idle` for tools, APIs, and WebUI displays.

## Key Exports

- `SessionRuntimeState` / related type aliases — shared backend payload shape for runtime state.
- `setActiveSessionRuntimeState(sessionId, state)` — records transient active `requesting-model` or `running-tool` state and notifies session-list listeners.
- `clearActiveSessionRuntimeState(sessionId)` — clears transient active state when a session leaves active processing.
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
| `getActiveSessionRuntimeState(sessionId)` | Returns active state without derivation. |
| `buildSessionRuntimeState(session)` | Applies priority order: active state, persisted wait, busy fallback, idle. |
| `formatSessionRuntimeStateSummary(runtimeState)` | Formats short labels such as `running-tool:exec 1/1`, `waiting:sessions 1/2`, or `idle`. |

## Dependencies

- `./types` — `Session` shape and queue metadata.

## Behavior

- Active `requesting-model` / `running-tool` state is transient and never persisted.
- Persisted `session.meta.wait` drives `waiting` after the active turn has ended only when the wait has an explicit UI-visible target/reason.
- `waitAll.sessions` derives `waitingFor: 'sessions'` with satisfied and pending lists, and takes display precedence if combined with advisory exec ids.
- `waitExecIds` derives `waitingFor: 'exec'` when no wait-all target is present and is advisory UI/status metadata.
- Timeout-only waits derive `waitingFor: 'timer'`; bare/reason-only `wait` calls are treated as `idle` even though the wait token remains persisted for wake semantics.
- If a legacy/stale session is `busy` but no active transient state exists, the builder falls back to `requesting-model` with `active.phase: 'unknown'` so old payloads do not appear idle.

## Integration

- `sessionManager` re-exports the builder and active-state setters, includes `runtimeState` in `listSessions()`, and fans state changes out through independent global-list and targeted per-session callbacks for WebUI SSE consumers.
- `messageRouter` sets `requesting-model` around LLM calls and `running-tool` around tool execution, then clears active state when session processing ends.
- `sessionStatus` and WebUI `/api/sessions` expose the derived payload while preserving legacy `busy` / `busyStartedAt` / `queueLength` fields.

## Design Decisions

- [2026-07-07] Canonical runtime state has four top-level states: `requesting-model`, `running-tool`, `waiting`, and `idle`. Active model/tool phases are transient in memory; wait state remains persisted in `session.meta.wait`. Generic `wait({})` remains valid and is displayed as `idle`, not forced to specify session or exec targets, because common subagent handoff (`send_to_session` then `wait({})`) means the stage is complete and the session is simply waiting for parent/user input.
