# Unit: src-wait-tool

Files: src/toolsSessionAgent/waitTool.test.ts

## Purpose

Tests the `wait` tool functionality, including timeout behavior, `waitAllSessions` argument validation, session queue processing during wait states, compaction interactions, and timer persistence. Ensures the wait mechanism correctly manages session state transitions, deferred message delivery, and edge cases like stop signals and stale timeouts.

## Key Exports

- No exports (test file only)

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `makeSessionId(prefix)` | ~23 | Generates a unique session ID with timestamp and random suffix |
| `cleanupSession(sessionId)` | ~27 | Deletes a session, swallowing errors |
| `seedCompactableHistory(sessionId)` | ~31 | Populates a session with large messages to trigger compaction thresholds |
| `sleep(ms)` | ~42 | Promise-based delay utility |
| `waitFor(predicate, timeoutMs, intervalMs)` | ~46 | Polls a predicate until true or timeout, then asserts failure |
| `flattenPartsText(parts)` | ~55 | Concatenates system/text fields from message parts into a single string |
| `appendStubTurn(activeSession, parts, responseText)` | ~61 | Appends a user+model message pair to simulate an LLM turn |
| `waitForSessionIdle(sessionId)` | ~72 | Waits until a session is not busy and has an empty queue |
| `withTempTimerStore(run)` | ~78 | Sets up a temporary file-backed timer store for isolated timer tests |

## Dependencies

- `./messageRouter` — `MessageRouter` for processing session queues
- `./sessionManager` — session CRUD, wait management, queue operations
- `./llm` — mocked `chat` and `executeTools` for simulating LLM responses
- `./vector` — mocked `scheduleSessionArchiveIndex`
- `./timers` — `buildWaitTimeoutMessage`, `createTimer`, `createTimersStore`, `resetTimersForTests`, `setTimersStoreForTests`
- `./tools` — `definitions` (tool schema registry)
- `./toolsSessionAgent` — `tool_wait` (the tool under test)
- `./types` — `Message`, `MessagePart`, `Session` types

## Behavior

- Validates `waitAllSessions` argument types, empty arrays, whitespace, duplicates, and de-duplication
- Validates `waitExecIds` as optional non-empty string IDs and confirms they are stored as advisory runtime-state metadata.
- Verifies that wait timeouts queue a system event and clear wait metadata
- Confirms compact-commit and compact queue items are "wait-neutral" (don't cancel the wait)
- Tests that stop signals during tool execution prevent stale compaction triggers
- Ensures `waitAllSessions` defers incoming child messages until all expected sessions report, then delivers them in a single batch
- Tests timer persistence: timers survive across store reloads and fire correctly
- Validates that stale timeout tokens (from cancelled waits) are ignored
- Confirms that replacing a wait with deferred messages is rejected to prevent message loss
- Tests interaction between compaction queue items and waitAll deferred queues
- Covers router immediate-reply behavior around commands/authorization and confirms busy user messages are enqueued without a queued/busy acknowledgement.
- Confirms generic `wait({})` remains supported and derives `idle` through the runtime-state builder while still storing a wait token for wake semantics.

## Integration

Exercises the coordination between `sessionManager` (wait state, queue), `MessageRouter` (queue processing/draining), `timers` (persistent scheduled callbacks), and `toolsSessionAgent` (tool invocation entry point). Mocks the LLM layer to isolate wait/queue logic from actual model calls. Validates the contract that other subsystems (compaction, stop, child sessions) respect wait semantics.