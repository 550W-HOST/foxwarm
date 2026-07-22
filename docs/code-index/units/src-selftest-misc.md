# Unit: src-selftest-misc

Files: src/selftest/queueDrainSelfTest.ts, src/selftest/toolLoopStallSelfTest.ts

## Purpose

Self-test suite that verifies the message router's queue drain behavior and tool loop continuation logic. Tests ensure queued events are consumed in correct order during active tool loops, compaction boundaries are handled properly, and child/parent session interactions (including failure propagation) work as expected.

## Key Exports

These files have no exports — they are standalone self-test scripts executed via their `main()` entrypoints.

## Function Index

### queueDrainSelfTest.ts

| Function | Lines (approx) | Description |
|----------|---------------|-------------|
| `makeSessionId(prefix)` | ~10 | Generates a unique session ID with timestamp and random suffix |
| `createBaseSession(id)` | ~14-24 | Creates a minimal Session object with default fields |
| `ensureSession(id)` | ~26-31 | Gets or resets a session to base state and persists it |
| `cleanupSessions(sessionIds)` | ~33-40 | Deletes sessions by ID, ignoring failures |
| `appendStubUserMessage(session, parts)` | ~42-49 | Appends a user message to session history if parts exist |
| `appendStubModelMessage(session, text)` | ~51-56 | Appends a model message with text to session history |
| `assertLastModelText(session, expected)` | ~58-63 | Asserts the last history entry is a model message with expected text |
| `test(name, fn)` | ~65-72 | Test runner wrapper that logs PASS/FAIL |
| `main()` | ~74-end | Orchestrates all queue drain tests with mocked LLM and tool execution |

### toolLoopStallSelfTest.ts

| Function | Lines (approx) | Description |
|----------|---------------|-------------|
| `makeSessionId(prefix)` | ~16 | Generates a unique session ID with timestamp and random suffix |
| `createBaseSession(id, parentSessionId?)` | ~20-32 | Creates a minimal Session object, optionally with parent reference |
| `ensureSession(id, parentSessionId?)` | ~34-39 | Gets or resets a session to base state and persists it |
| `cleanupSessions(sessionIds)` | ~41-48 | Deletes sessions by ID, ignoring failures |
| `appendStubUserMessage(session, parts)` | ~50-57 | Appends a user message to session history if parts exist |
| `appendStubModelMessage(session, parts)` | ~59-64 | Appends a model message with given parts to session history |
| `appendLocalMessage(session, role, parts)` | ~66-71 | Pushes a message directly onto session history array with metadata |
| `assertLastModelText(session, expected)` | ~73-78 | Asserts the last history entry is a model message with expected text |
| `test(name, fn)` | ~82-89 | Test runner wrapper that logs PASS/FAIL |
| `main()` | ~91-end | Orchestrates all tool loop stall and continuation tests |

## Dependencies

| Module | Usage |
|--------|-------|
| `../messageRouter` | `MessageRouter` class — the system under test for turn execution and queue processing |
| `../sessionManager` | Session CRUD, queue operations, compaction, message appending |
| `../llm` | `chat` and `executeTools` — monkey-patched to stub LLM responses |
| `../vector` | `scheduleSessionArchiveIndex` — stubbed out to prevent indexing side effects |
| `../session/history` | `formatCompactionCompletionMarker` — used to build expected compaction markers |
| `../session/compactPlan` | `COMPACT_FLOW_MAX_ROUNDS` — used to verify compaction round limits |
| `../toolsSessionAgent` | `tool_get_archived_messages`, `tool_set_goal` — referenced for tool definitions in stall tests |

## Behavior

- Monkey-patches `llm.chat`, `llm.executeTools`, `sessionManager.processSessionCompactionRequest`, `axios.post`, and vector indexing to isolate the message router logic.
- Queue drain tests verify that structured events, message events, and compaction items queued mid-tool-execution are consumed in the correct order within the same turn.
- Tool loop stall tests verify multi-step tool chains (apply_patch → read → exec → final response) complete without stalling.
- Child/parent session tests verify child sessions can read files, send results to parents, and that parent sessions process those notifications.
- Compaction-triggered tests verify that when history grows large, compaction fires and the session continues processing remaining work afterward.
- Failure propagation tests verify that network errors during LLM calls surface as error messages in session history.
- All tests clean up created sessions and temp files in a `finally` block.

## Integration

- Exercises `MessageRouter.runSessionTurn` and `MessageRouter.processSessionQueue` — the core turn-execution paths used by the production message handling pipeline.
- Validates the contract between the router, session manager queue operations, and LLM call/tool-execution cycle.
- Tests the compaction flow boundary where `processSessionCompactionRequest` interleaves with ordinary queued work.
- Confirms parent/child session notification via `send_to_session` tool integration.