# Unit: src-managed-sessions

Files: src/managedSessions.ts, src/managedSessions.test.ts, src/toolsSessionAgent/sessionChildModel.test.ts

## Purpose

Provides a managed session lifecycle where one "owner" session can take exclusive control of another session, intercept its incoming queue items into a pending inbox, execute controlled processing steps, and release control. Also tests child session model inheritance and prompt cache key propagation.

## Key Exports

- `OpenManagedSessionResult` — type returned when opening a managed session
- `ManagedSessionStepResult` — type returned after executing a managed step
- `openManagedSession(args)` — acquires exclusive managed control over a target session
- `managedSessionStep(args)` — executes one processing step on a managed session with inbox/manager input ordering
- `releaseManagedSession(args)` — releases managed control and restores pending inbox to the session queue
- `isManagedSessionBusyForStep(sessionId)` — checks if a managed step is currently in progress
- `getManagedSessionStateForTests(sessionId)` — test helper to inspect managed state

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `buildManagedStepId()` | ~47 | Generates a unique step ID by rewriting a lease ID prefix |
| `cloneQueueItems(items)` | ~51 | Deep-clones an array of queue items |
| `requireOwnedManagedState(sessionId, state, ownerSessionId, leaseId)` | ~55 | Validates ownership and lease, throws on mismatch |
| `prependQueueItems(sessionQueue, items)` | ~67 | Prepends cloned items to the front of a session queue |
| `buildManagerQueueItems(args)` | ~73 | Converts manager-provided parts/message into intersession queue items |
| `getQueueItemsEligibleForManagedInbox(queue)` | ~89 | Splits queue into interceptable items and retained compact items |
| `isManagedSessionBusyForStep(sessionId)` | ~103 | Checks the in-memory active steps set |
| `openManagedSession(args)` | ~107 | Resolves target, reclaims stale leases, intercepts queue, sets managed state |
| `managedSessionStep(args)` | ~143 | Validates lease/revision, assembles queue, triggers processing, returns new messages |
| `releaseManagedSession(args)` | ~213 | Validates ownership, restores pending inbox to queue, clears managed state |
| `getManagedSessionStateForTests(sessionId)` | ~248 | Fetches managed state for test assertions |
| `appendStubUserMessage(session, parts)` | ~test:9 | Test helper: appends a user message to session history |
| `appendStubModelMessage(session, text)` | ~test:15 | Test helper: appends a model message to session history |
| `flattenText(parts)` | ~test:22 | Test helper: joins message parts into pipe-delimited string |
| `makeId(prefix)` | ~test(child):8 | Test helper: generates unique session IDs |
| `createBaseSession(id, model)` | ~test(child):12 | Test helper: builds a minimal Session object |
| `ensureSession(id, model)` | ~test(child):26 | Test helper: creates/resets a session with given model |
| `getTestModels()` | ~test(child):33 | Test helper: resolves primary and secondary model keys from config |

## Dependencies

- `./types` — `Message`, `MessagePart`, `QueueItem`, `Session`
- `./sessionManager` — session CRUD, queue operations, trigger processing, save/load
- `./session/relations` — `resolvePermittedSessionTarget` for access control
- `./session/managedState` — `buildManagedSessionLeaseId`, `getManagedSessionState`, `setManagedSessionState`, `isManagedSessionLeaseExpired`, `ManagedSessionState`, `cloneQueueItem`
- `./messageRouter` — used in tests for queue processing
- `./llm` — mocked in tests
- `./config` — `resolveModelConfig` used in child model tests
- `./toolsSessionAgent` — `tool_create_child_session`, `tool_create_session`, `tool_set_session_child_model`

## Behavior

- **Lease-based ownership**: Only one owner can manage a session at a time; stale leases (expired or owner deleted) are automatically reclaimed on next open attempt.
- **Inbox interception**: When a session is managed, incoming queue items (except compact operations) are diverted into `pendingInbox` rather than processed immediately.
- **Atomic step execution**: `managedSessionStep` assembles manager input and pending inbox items in configurable order (`before`/`after`/`ignore`), prepends them to the session queue, triggers processing, and returns new messages produced.
- **Concurrency guard**: An in-memory `activeManagedSteps` set prevents concurrent steps on the same session.
- **Revision tracking**: Each inbox arrival and step increments the revision counter; callers can pass `expectedRevision` for optimistic concurrency control.
- **Owner notification**: When inbox items arrive, the owner session is notified via a system queue event.
- **Child model tests** verify that `childModelDefault` propagates to new/forked children, `promptCacheKey` is inherited, and forked children get synthetic tool-role messages.

## Integration

- Sits between the `MessageRouter` (which checks managed state before auto-running sessions) and `sessionManager` (which persists state and triggers processing).
- Owner sessions use these APIs as tool calls within a ToolScript run to orchestrate child/linked sessions.
- `resolvePermittedSessionTarget` enforces session relationship permissions before granting managed access.
- `resumeBusySessions` in `sessionManager` re-notifies owners on restart if pending inbox items survived.