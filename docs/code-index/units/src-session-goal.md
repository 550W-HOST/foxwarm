# Unit: src-session-goal

Files: src/session/goal.ts, src/session/goal.test.ts, src/selftest/goalReminderSelfTest.ts

## Purpose

Manages session-level goal tracking, including setting/clearing goals and building reminder messages for router-owned pre-provider or end-of-turn history boundaries.

## Key Exports

- `DEFAULT_GOAL_REMIND_EVERY` — default interval (10) for goal reminders
- `normalizeRemindEvery(value)` — validates and normalizes the reminder interval
- `normalizeRemindOnTurnEnd(value)` — validates the end-turn reminder flag
- `normalizeGoalText(value)` — validates and trims goal text
- `getLatestSessionMessageSeq(session)` — returns the highest message sequence number
- `isGoalReminderMessage(message)` — checks if a message is a goal reminder
- `getLatestCountedMessageSeq(session)` — latest seq excluding reminder messages
- `formatSessionGoalReminderText(goal)` — formats the reminder as a single `<foxwarm-system kind="goal-reminder">goal/guidance</foxwarm-system>` wrapper
- `countNonReminderMessagesAfterSeq(session, anchorSeq)` — counts non-reminder messages after a given seq
- `resolveSessionGoalRemindEvery(session, value)` — resolves remindEvery from explicit value, session state, or default
- `resolveSessionGoalRemindOnTurnEnd(session, value)` — resolves remindOnTurnEnd flag
- `setSessionGoal(session, goal, remindEvery, remindOnTurnEnd)` — persists goal state on the session
- `clearSessionGoal(session)` — removes goal state from the session
- `maybeBuildGoalReminderMessage(session)` — builds an interval-based reminder if conditions are met
- `maybeBuildGoalEndTurnReminderMessage(session)` — builds an end-of-turn reminder if conditions are met

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `normalizeRemindEvery(value)` | ~12–23 | Validates and truncates remindEvery to a positive integer |
| `normalizeRemindOnTurnEnd(value)` | ~25–31 | Validates remindOnTurnEnd as boolean |
| `normalizeGoalText(value)` | ~33–40 | Validates goal is a string and trims whitespace |
| `getLatestSessionMessageSeq(session)` | ~42–54 | Returns highest message seq from nextMessageSeq or history scan |
| `isGoalReminderMessage(message)` | ~56–58 | Checks meta key for goal reminder flag |
| `getLatestCountedMessageSeq(session)` | ~60–73 | Finds latest seq skipping reminder messages |
| `getLatestNonReminderMessage(session)` | ~75–83 | Returns last non-reminder message from history |
| `getLatestUserMessage(session)` | ~85–93 | Returns last user-role message from history |
| `latestMessageSuppressesGoalReminder(session)` | ~95–98 | Checks if latest model message contains a no-action signal |
| `hasGoalReminderForAnchorSeq(session, anchorSeq)` | ~100–112 | Checks if a reminder already exists for a given anchor seq |
| `getLatestGoalReminderMessage(session)` | ~114–122 | Returns the most recent goal reminder message |
| `shouldSuppressEndTurnReminderAfterCompactCompletion(session, state)` | ~124–140 | Prevents duplicate reminder after compact-completion marker |
| `buildGoalReminderMessage(state, anchorSeq, kind)` | ~142–153 | Constructs the reminder Message object with metadata |
| `formatSessionGoalReminderText(goal)` | ~155–157 | Formats goal reminder metadata tag plus goal/guidance strings |
| `countNonReminderMessagesAfterSeq(session, anchorSeq)` | ~159–173 | Counts messages after anchor, excluding reminders |
| `resolveSessionGoalRemindEvery(session, value)` | ~175–185 | Resolves effective remindEvery value with fallback chain |
| `resolveSessionGoalRemindOnTurnEnd(session, value)` | ~187–193 | Resolves effective remindOnTurnEnd with fallback |
| `setSessionGoal(session, goal, remindEvery, remindOnTurnEnd)` | ~195–211 | Normalizes inputs and writes goalState to session |
| `clearSessionGoal(session)` | ~213–219 | Deletes goalState from session |
| `maybeBuildGoalReminderMessage(session)` | ~221–247 | Interval reminder: checks threshold, suppression, dedup, then builds |
| `maybeBuildGoalEndTurnReminderMessage(session)` | ~249–280 | End-turn reminder: checks enabled, suppression, compact, dedup, then builds |

Self-test file (`goalReminderSelfTest.ts`):

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `makeSessionId(prefix)` | ~14–16 | Generates a unique session ID for tests |
| `createBaseSession(id, parentSessionId)` | ~18–29 | Creates a minimal Session object |
| `ensureSession(id, parentSessionId)` | ~31–36 | Gets or resets a session via sessionManager |
| `cleanupSessions(sessionIds)` | ~38–46 | Deletes test sessions, ignoring errors |
| `appendStubUserMessage(session, parts)` | ~48–54 | Appends a stub user message if parts exist |
| `appendStubModelMessage(session, text)` | ~56–61 | Appends a stub model message with text |
| `countGoalReminders(session)` | ~63–65 | Counts goal reminder messages in history |
| `test(name, fn)` | ~67–75 | Simple test runner with pass/fail logging |
| `main()` | ~81–end | Orchestrates all self-test scenarios |

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
- `maybeBuildGoalEndTurnReminderMessage` fires at end-of-turn unless disabled, suppressed by no-action signal, or already covered by a recent compact-completion reminder.
- Both functions mutate `state.anchorSeq` as a side effect to track the last reminder point.
- Reminders are suppressed when the latest model message contains a no-action signal or when the latest user message is itself a reminder.
- Reminder messages use a one-part format: a `system` part containing `<foxwarm-system kind="goal-reminder">` with the raw goal plus guidance in the tag body.

## Integration

- `MessageRouter` owns interval evaluation at its pre-provider safe point and direct history append; `sessionManager` history append does not queue or synthesize goal work.
- The router appends end-turn reminders directly after a completed turn. Compact completion writes its separately tagged reminder through the history subsystem.
- `setSessionGoal` / `clearSessionGoal` are invoked by the `set_goal` tool in `toolsSessionAgent`.
- Interacts with session persistence via `sessionManager` (saving goalState alongside history).
- Relies on `childSessionReminder`'s no-action signal detection to suppress reminders when the model signals inactivity.
- The self-test exercises the full integration path through `MessageRouter.processSessionQueue` and `runSessionTurn`.

## Design Decisions

- [2026-07-06] Goal reminders should use the same Foxwarm metadata tag style as other system metadata: `<foxwarm-system kind="goal-reminder">raw reminder content</foxwarm-system>`, instead of the legacy `Session goal reminder:` text header or split `systemPayload`. Compact-completion goal reminders should be stored as separate parts so the goal-reminder tag remains recognizable.

### D-goal-direct-safe-boundary

[2026-07-25] Interval goal reminders are canonical history context evaluated and appended at the router's pre-provider safe boundary, never session `QueueItem`s or synthetic standalone LLM turns. The boundary follows persisted queued input or a complete tool result, so a reminder cannot split a model function-call message from its tool result. End-turn and compact-completion suppression continue to prevent a companion reminder for the same turn.
