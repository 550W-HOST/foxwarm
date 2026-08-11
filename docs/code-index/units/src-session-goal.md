# Unit: src-session-goal

Files: src/session/goal.ts, src/session/goal.test.ts, src/selftest/goalReminderSelfTest.ts

## Purpose

Manages session-level goal tracking, including setting/clearing goals and building interval reminder messages for the router-owned pre-provider history boundary.

## Key Exports

- `DEFAULT_GOAL_REMIND_EVERY` — default interval (20) for goal reminders
- `normalizeRemindEvery(value)` — validates and normalizes the reminder interval
- `normalizeGoalText(value)` — validates and trims goal text
- `getLatestSessionMessageSeq(session)` — returns the highest message sequence number
- `isGoalReminderMessage(message)` — checks if a message is a goal reminder
- `getLatestCountedMessageSeq(session)` — latest seq excluding reminder messages
- `formatSessionGoalReminderText(goal)` — formats the reminder as a single `<foxwarm-system kind="goal-reminder">goal/guidance</foxwarm-system>` wrapper
- `countNonReminderMessagesAfterSeq(session, anchorSeq)` — counts non-reminder messages after a given seq
- `resolveSessionGoalRemindEvery(session, value)` — resolves remindEvery from explicit value, session state, or default
- `setSessionGoal(session, goal, remindEvery)` — persists goal state on the session
- `clearSessionGoal(session)` — removes goal state from the session
- `maybeBuildGoalReminderMessage(session)` — builds an interval-based reminder if conditions are met

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `normalizeRemindEvery(value)` | ~12–23 | Validates and truncates remindEvery to a positive integer |
| `normalizeGoalText(value)` | ~25–32 | Validates goal is a string and trims whitespace |
| `getLatestSessionMessageSeq(session)` | ~34–46 | Returns highest message seq from nextMessageSeq or history scan |
| `isGoalReminderMessage(message)` | ~48–50 | Checks meta key for goal reminder flag |
| `getLatestCountedMessageSeq(session)` | ~52–65 | Finds latest seq skipping reminder messages |
| `getLatestNonReminderMessage(session)` | ~67–75 | Returns last non-reminder message from history |
| `getLatestUserMessage(session)` | ~77–85 | Returns last user-role message from history |
| `latestMessageSuppressesGoalReminder(session)` | ~87–90 | Checks if latest model message contains a no-action signal |
| `hasGoalReminderForAnchorSeq(session, anchorSeq)` | ~92–104 | Checks if a reminder already exists for a given anchor seq |
| `buildGoalReminderMessage(state, anchorSeq)` | ~106–117 | Constructs an interval reminder Message object with metadata |
| `formatSessionGoalReminderText(goal)` | ~119–121 | Formats goal reminder metadata tag plus goal/guidance strings |
| `countNonReminderMessagesAfterSeq(session, anchorSeq)` | ~123–137 | Counts messages after anchor, excluding reminders |
| `resolveSessionGoalRemindEvery(session, value)` | ~139–149 | Resolves effective remindEvery value with fallback chain |
| `setSessionGoal(session, goal, remindEvery)` | ~151–164 | Normalizes inputs and writes goalState to session |
| `clearSessionGoal(session)` | ~166–172 | Deletes goalState from session |
| `maybeBuildGoalReminderMessage(session)` | ~174–201 | Interval reminder: checks threshold, suppression, dedup, then builds |

Self-test file (`goalReminderSelfTest.ts`):

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `makeSessionId(prefix)` | ~14–16 | Generates a unique session ID for tests |
| `createBaseSession(id, parentSessionId)` | ~18–29 | Creates a minimal Session object |
| `ensureSession(id, parentSessionId)` | ~31–36 | Gets or resets a session via sessionManager |
| `cleanupSessions(sessionIds)` | ~38–46 | Deletes test sessions, ignoring errors |
| `countGoalReminders(session)` | ~46–48 | Counts goal reminder messages in history |
| `test(name, fn)` | ~50–58 | Simple test runner with pass/fail logging |
| `main()` | ~60–end | Orchestrates all self-test scenarios |

## Dependencies

- `../types` — `Message`, `Session`, `SessionGoalState`
- `./childSessionReminder` — `partsContainNoActionSignal`
- `../utils/systemMessageParts` — `buildSystemMessageParts`
- `../messageRouter` — `MessageRouter` (self-test)
- `../llm` — `chat` (mocked in self-test)
- `../sessionManager` — session CRUD and message append (self-test)
- `../vector` — `scheduleSessionArchiveIndex` (stubbed in self-test)
- `../toolsSessionAgent` — `tool_set_goal` (self-test)
- `../session/metadataStore` — `getSessionHistoryFilePath` (self-test)

## Behavior

- Goal state is stored on `session.goalState` with goal text, interval, anchor seq, and timestamps.
- `maybeBuildGoalReminderMessage` fires an interval reminder when the count of non-reminder messages since the last anchor reaches `remindEvery`. The router evaluates and appends it immediately before a real provider request, after queued input or a preceding tool result is canonical history.
- The interval builder mutates `state.anchorSeq` as a side effect to track the last reminder point.
- Reminders are suppressed when the latest model message contains a no-action signal or when the latest user message is itself a reminder.
- Reminder messages use a one-part format: a `system` part containing `<foxwarm-system kind="goal-reminder">` with the raw goal plus guidance in the tag body.

## Integration

- `MessageRouter` owns interval evaluation at its pre-provider safe point and direct history append; `sessionManager` history append does not queue or synthesize goal work.
- Compact completion writes its separately tagged goal context through the history subsystem.
- `setSessionGoal` / `clearSessionGoal` are invoked by the `set_goal` tool in `toolsSessionAgent`.
- Interacts with session persistence via `sessionManager` (saving goalState alongside history).
- Relies on `childSessionReminder`'s no-action signal detection to suppress reminders when the model signals inactivity.
- The self-test exercises the full integration path through the public `MessageRouter.processSessionQueue` owned-entry path.

## Design Decisions

- [2026-07-06] Goal reminders should use the same Foxwarm metadata tag style as other system metadata: `<foxwarm-system kind="goal-reminder">raw reminder content</foxwarm-system>`, instead of the legacy `Session goal reminder:` text header or split `systemPayload`. Compact-completion goal reminders should be stored as separate parts so the goal-reminder tag remains recognizable.

### D-goal-direct-safe-boundary

[2026-07-26] Goals are interval-only. `set_goal` exposes `remindEvery`, not an end-turn control, and the router never creates end-of-turn goal reminders. The fallback interval is 20 messages; existing persisted or explicitly provided intervals remain unchanged. A due interval reminder is canonical history context evaluated and appended at the pre-provider safe boundary, never a session `QueueItem` or synthetic standalone LLM turn. The boundary follows persisted queued input or a complete tool result, so a reminder cannot split a model function-call message from its tool result. Compact completion keeps its separate goal context. Legacy persisted end-turn flags remain readable but are omitted by current writers.
