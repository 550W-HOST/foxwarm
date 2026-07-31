# Unit: src-session-misc

Files: src/session/archive.ts, src/session/relations.ts, src/session/managedState.ts, src/session/messageVisibility.ts, src/session/snapshotRefresh.ts, src/session/childSessionReminder.ts, src/session/childSessionReminder.test.ts, src/session/sessionResumeDedup.test.ts, src/session/sessionSnapshotAutoRefresh.test.ts

## Purpose

Provides session archiving (persisting messages with canonical image references), parent/child session relationship management, managed session state tracking (leases, inboxes), message visibility control for display-only messages, stale session snapshot auto-refresh logic, and child session completion/reminder signaling.

## Key Exports

- `ArchiveMessageRecord` — interface for serialized archive message entries
- `buildArchiveRecord`, `appendMessagesToArchive`, `readArchiveMessages`, `readLocalArchiveMessages`, `readArchiveMessagesBySeqRange`, `readLocalArchiveMessagesBySeqRange` — archive read/write functions
- `ensureMessageSeq`, `getNextSessionMessageSeq`, `stripMessageSeq` — message sequence utilities
- `setSessionParent`, `resolveSessionParentId`, `updateChildSessionParentIds`, `getChildSessionIds`, `getCanonicalChildSessionIds`, `collectSessionDescendants`, `isDirectSessionLink` — session relationship management and alias-normalized lifecycle traversal
- `resolvePermittedSessionTarget`, `sendToSession` — inter-session messaging with special target resolution (`<main>`, `<parent>`), isolation checks, self-send rejection, and source-boundary timestamped metadata
- `ManagedSessionState`, `getManagedSessionState`, `setManagedSessionState`, `isManagedSessionActive`, `isManagedSessionLeaseExpired`, `shouldRouteQueueItemToManagedInbox` — managed session lease/state
- `isModelVisibleMessage`, `createDisplayOnlyModelMessage`, `redactDisplayOnlyMessageForModel`, `formatModelVisibilitySuffix` — message visibility helpers
- `maybeRefreshStaleSessionSnapshot`, `shouldAutoRefreshSessionSnapshot`, `getSessionIdleMs`, `AUTO_REFRESH_STALE_SESSION_SNAPSHOT_MS` — snapshot refresh logic
- `isNoActionSignalText`, `isModelNoActionSignal`, `buildChildCompletionInstruction`, `buildChildReminder`, `NO_ACTION_MARKER` — child session reminder/completion signaling

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `getMessageTimestamp(message)` | ~28 | Returns message timestamp or current time |
| `getNextSessionMessageSeq(session)` | ~32 | Computes next available sequence number for a session |
| `ensureMessageSeq(session, message)` | ~48 | Assigns or validates a sequence number on a message |
| `buildArchiveRecord(session, message)` | ~66 | Builds an archive record after canonical image materialization |
| `appendMessagesToArchive(session, messages)` | ~126 | Appends messages to archive log and store |
| `readArchiveMessages(sessionId)` | ~143 | Reads effective archive messages for a session |
| `readLocalArchiveMessages(sessionId)` | ~147 | Reads local-only archive messages |
| `stripMessageSeq(message)` | ~151 | Removes seq metadata from a message clone |
| `readArchiveMessagesBySeqRange(sessionId, start, end)` | ~163 | Reads archive messages within a seq range |
| `readLocalArchiveMessagesBySeqRange(sessionId, start, end)` | ~167 | Reads local archive messages within a seq range |
| `persistSessionMetadataUpdate(deps, sessionId, updates)` | ~20 | Persists partial session metadata to history file |
| `getChildSessionIds(sessions, parentSessionId)` | ~34 | Returns IDs of child sessions for a parent |
| `getCanonicalChildSessionIds(sessions, parentSessionId)` | relations.ts | Returns alias-normalized direct child IDs without traversing deeper relations |
| `collectSessionDescendants(sessions, rootSessionId)` | relations.ts | Returns canonical descendants/direct children/deepest-first order and rejects corrupt cycles |
| `resolveSessionParentId(deps, childSessionId, parentSessionId)` | relations.ts | Resolves aliases and validates existence/self/cycle constraints without mutating the relation |
| `setSessionParent(deps, childSessionId, parentSessionId)` | ~40 | Sets or clears a session's parent relationship |
| `updateChildSessionParentIds(deps, oldParentId, newParentId)` | ~82 | Re-parents all children from old to new parent |
| `isDirectSessionLink(a, b)` | ~100 | Checks if two sessions are the same or direct parent/child |
| `checkIsolatedPermission(deps, sourceSession, targetSessionId)` | ~106 | Validates agent isolation constraints, allowing explicit direct parent/child links before cross-agent isolation rejection |
| `resolvePermittedSessionTarget(deps, targetSessionId, fromSessionId)` | ~130 | Resolves special targets/aliases and target session with full isolation permission checks |
| `sendToSession(deps, targetSessionId, message, fromSessionId)` | ~152 | Sends an inter-session message as one source-timestamped `<foxwarm-message type="inter-agent" ...>body</foxwarm-message>` system part; rejects self-sends and returns requested/resolved IDs |
| `cloneQueueItem(item)` | ~25 | Deep-clones a queue item |
| `buildManagedSessionLeaseId()` | ~29 | Generates a unique managed session lease ID |
| `getManagedSessionState(session)` | ~33 | Parses and validates managed session state from session meta |
| `setManagedSessionState(session, state)` | ~76 | Writes managed session state into session meta |
| `isManagedSessionActive(session)` | ~99 | Checks if a session has active managed state |
| `shouldRouteQueueItemToManagedInbox(session, item)` | ~103 | Determines if a queue item should go to managed inbox |
| `getManagedSessionLastTouchedAt(state)` | ~111 | Returns most recent activity timestamp for lease |
| `isManagedSessionLeaseExpired(state, now, ttlMs)` | ~119 | Checks if managed session lease has expired |
| `isModelVisibleMessage(message)` | ~5 | Checks if a message is visible to the model |
| `createDisplayOnlyModelMessage(text, meta)` | ~9 | Creates a model message marked display-only |
| `redactDisplayOnlyMessageForModel(message)` | ~19 | Replaces display-only message content with placeholder |
| `formatModelVisibilitySuffix(message)` | ~29 | Returns suffix string for display-only messages |
| `getSessionIdleMs(session, now)` | ~8 | Calculates milliseconds since last message |
| `shouldAutoRefreshSessionSnapshot(session, now)` | ~16 | Checks if session is stale enough for refresh |
| `maybeRefreshStaleSessionSnapshot(session, refresh, now)` | ~20 | Conditionally triggers snapshot refresh with error handling |
| `isNoActionSignalText(text)` | ~7 | Detects no-action marker in text |
| `partsContainNoActionSignal(parts)` | ~13 | Checks if any message part contains no-action signal |
| `isModelNoActionSignal(message)` | ~17 | Checks if a model message is a no-action signal |
| `buildChildCompletionInstruction(parentSessionId)` | ~21 | Builds instruction text for child session completion |
| `buildChildReminder(parentSessionId)` | ~25 | Builds reminder text when child didn't hand off |

## Dependencies

- `../types` — `Message`, `MessagePart`, `Session`, `QueueItem`
- `../config` — `getSessionArchiveLogPath`
- `../imageBlobs` — canonical image blob materialization
- `../common` — `logger`
- `./archiveStore` — `ensureSessionBranch`, `refreshSessionArchiveImportState`, `readEffectiveArchiveMessages`, `readLocalArchiveMessages`, `writeArchiveMessages`
- `./metadataStore` — `getSessionHistoryFilePath`, `getSessionHistoryStore`
- `./agentMetadata` — `AgentMetadata`

## Behavior

- **Archive**: Canonicalizes image parts through the shared blob store before appending JSONL records plus SQLite rows. New archive rows contain blob references rather than inline base64 or per-session filesystem paths; compatible readers retain old path records. Creation rollback can remove a partial append for a known uncommitted lifetime.
- **Relations**: Enforces agent isolation rules: if either side is isolated, an explicit direct parent/child link is allowed in either direction even across agent boundaries, while sibling and unrelated sessions are rejected. It also validates circular parent references and persists parent changes to metadata store.
- **Inter-session target resolution and self-send guard**: `sendToSession` resolves literal `<main>` to the current agent's canonical main session and `<parent>` to the current session's parent before isolation/session lookup; `<parent>` without a parent errors clearly. It rejects cases where the resolved source session and target session are the same. The delivered content is wrapped as a single source-timestamped `<foxwarm-message type="inter-agent" sourceSessionId="..." replyVia="send_to_session" ...>raw body</foxwarm-message>` system part with escaped attrs and raw body text. The error includes `current_session_id`, `requested_session_id`, and `resolved_session_id` to correct agent identity confusion, and says that messages to the current session's direct user should be ordinary assistant text rather than `send_to_session`. Timestamp ownership is canonical in [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time).
- **Managed state**: Tracks session ownership via leases with TTL (15 min), manages pending inbox for managed sessions, routes queue items based on managed status.
- **Message visibility**: Supports display-only messages that are hidden from the model (replaced with placeholder text during inference).
- **Snapshot refresh**: Auto-refreshes session prompt snapshots after 1 hour of inactivity, with graceful error handling that doesn't block processing.
- **Child reminder**: Detects `[NO_ACTION]` signals from child sessions to suppress completion reminders, builds instruction/reminder text for inter-session handoff protocol, and recommends one flagged `send_to_session(..., waitAfterHandoff:true)` call rather than a separate explicit wait. Reminder system events use one `<foxwarm-system kind="child-reminder" event="missing-handoff" parentSessionId="...">reminder</foxwarm-system>` part instead of a generic `hint` wrapper or split `systemPayload`.

## Integration

- Archive functions are called by the session manager when messages are appended, providing persistence and replay capability.
- Relations module is used by session creation/management to maintain parent-child hierarchies and enforce agent isolation during inter-session communication.
- Managed state is used by orchestration logic to coordinate multi-step agent workflows with lease-based ownership.
- Message visibility integrates with the LLM chat pipeline to filter what the model sees vs. what the user sees.
- Snapshot refresh is invoked by the `MessageRouter` before processing a new turn to ensure stale sessions have up-to-date memory snapshots.
- Child session reminder logic is used by the session turn processor to nudge child sessions that haven't reported back to their parent.

## Design Decisions

- [2026-07-13] Inter-session isolation uses the persisted session relation as a narrow exception to the cross-agent boundary: an explicit direct `parentSessionId` link permits parent↔child communication when one or both agents are isolated. Siblings and unrelated cross-agent sessions remain denied; this does not broaden agent, node, file, or tool permissions.
- [2026-07-06/2026-07-07] Inter-session source headers use a single `<foxwarm-message type="inter-agent" ...>raw body</foxwarm-message>` system part instead of literal `[SYSTEM:]` text or split body parts. Attribute values are escaped, but the message body is intentionally left raw per user decision; existing `[SYSTEM:]` histories remain compatible.
- [2026-07-07] Child-session missing-handoff reminders should be structured as `kind="child-reminder" event="missing-handoff"` metadata with the human reminder in the same foxwarm-system body, not as `<foxwarm-system hint="Reminder: ..." />` or a split `systemPayload` part.