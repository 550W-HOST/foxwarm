# Unit: src-timers

Files: src/timers.ts, src/timerScript.ts, src/timers.test.ts, src/timerScript.test.ts, src/timerWorker.test.ts

## Purpose

Manages scheduled timers that deliver messages or execute owner-bound ToolScript — either as one-time events (at a specific timestamp) or recurring (via cron expressions). Timers persist to disk and are re-hydrated on initialization. The observable message-versus-script, captured-versus-live defaults, notification, and invocation-lifetime contract is owned by [ToolScript and scheduled work](../behaviors/automation-and-scheduled-work.md#schedule-a-message-or-execute-a-quiet-script). This unit locates schedule normalization, exact-owner execution, replacement fencing and persistence.

## Key Exports

- `SessionTimer` — interface for a stored timer record, with optional `action` (`message` by default) and a complete `script` specification
- `TimerView` — extended interface adding computed `mode` and `nextRunAt`
- `initializeTimers()` — loads timers from disk and schedules them
- `shutdownTimers()` — closes script admission, cancels scheduled jobs, and drains accepted script invocations before host/VM teardown
- `normalizeTimerScript` / `runTimerScriptForOwner` — reuse starter validation and canonical authorized dispatch without model history or caller-turn control
- `createTimer(args)` — creates and schedules a new one-time or cron timer
- `updateTimer(args)` — updates an existing non-internal timer in place, reschedules its job, and persists the updated record
- `createWaitTimeoutTimer(args)` — creates a timer that delivers a wait-timeout event
- `deleteTimer(timerId, sessionId?)` — cancels and removes a timer
- `listTimers(sessionId?)` — returns all non-wait-timeout timers as `TimerView[]`
- `isCronTimer(timer)` — exported helper used by tests and timer formatting
- `buildTimerTriggeredMessage(timer, firedAt)` — formats fired timer content as a `<foxwarm-message type="timer" ...>` source wrapper
- `buildWaitTimeoutMessage(timer)` — formats wait-timeout metadata as a `<foxwarm-system ...>payload</foxwarm-system>` wrapper
- `createTimersStore(filePath)` — factory for the disk persistence store
- `setTimersStoreForTests(store)` / `resetTimersForTests()` — test helpers
- `setTriggeredSessionNameFactoryForTests` / `fireTimerForTests` — deterministic new-session allocation test hooks
- `isTimersInitialized()` — returns initialization state

## Function Index

| Function | Description |
|----------|-------------|
| `shutdownTimers()` | Closes new script admission and drains accepted invocations before host teardown |
| `normalizeTimerAction(args)` | Builds a compatible message or complete ToolScript payload |
| `fireScriptTimer(timer)` | Runs one owner-bound slice, logs status and cleans up only its captured timer record |
| `normalizeTimerScript(value)` / `runTimerScriptForOwner(script, ctx)` | Reuse normal starter parsing and authorized execution without caller-turn state |
| `normalizeTimersPayload(raw, filePath)` | Validates and normalizes raw JSON from disk |
| `createTimersStore(filePath)` | Creates a `DiskJsonData` instance for timer persistence |
| `setTimersStoreForTests(store)` | Replaces the timers store and resets state for tests |
| `resetTimersForTests()` | Cancels all jobs and clears in-memory timers |
| `generateTimerId()` | Produces a random 8-char hex ID |
| `normalizeSessionPrefix(prefix)` | Validates and trims session prefix string |
| `buildTriggeredSessionName(prefix)` | Generates a unique session name with timestamp and random suffix |
| `setTriggeredSessionNameFactoryForTests(factory)` | Overrides generated timer-session names for deterministic allocation tests |
| `isCronTimer(timer)` | Checks if a timer has a cron expression |
| `getTimerMode(timer)` | Returns `'once'` or `'cron'` |
| `getNextRunAtFromJob(job)` | Extracts next invocation timestamp from a node-schedule Job |
| `getNextRunAt(timer)` | Computes next run timestamp for any timer |
| `buildTimerTriggeredMessage(timer, firedAt)` | Formats fired-timer content as a foxwarm-message wrapper |
| `buildWaitTimeoutMessage(timer)` | Formats wait-timeout notification as a foxwarm-system wrapper |
| `toTimerView(timer)` | Converts a `SessionTimer` to a `TimerView` |
| `saveTimers()` | Persists all timers to disk |
| `cancelTimerJob(timerId)` | Cancels a single scheduled job |
| `cancelAllJobs()` | Cancels all scheduled jobs |
| `fireTimer(timerId)` | Executes timer delivery logic and revalidates a persisted new-session model/effort snapshot against one current models-config snapshot before lifetime creation |
| `fireTimerForTests(timerId)` | Invokes timer delivery deterministically without waiting for the scheduler |
| `scheduleTimer(timer)` | Schedules a timer via node-schedule (cron or one-time) |
| `parseAbsoluteTime(at)` | Parses a timestamp from number or ISO string |
| `normalizeTimerScheduleArgs(args, options)` | Shared create/update validation for mutually exclusive `at` / `afterSeconds` / `cron` schedules |
| `normalizeTimerUpdate(existing, ownerSession, args)` | Builds an updated timer record while preserving omitted fields and enforcing new-session-only fields |
| `initializeTimers()` | Loads persisted timers from disk and schedules them |
| `createTimer(args)` | Validates input, creates, schedules, and persists a new timer |
| `updateTimer(args)` | Validates ownership/fields, updates an existing timer, refreshes scheduler state, and rolls back on scheduling errors |
| `createWaitTimeoutTimer(args)` | Creates a wait-timeout timer for a session |
| `listTimers(sessionId?)` | Filters and sorts active timers into views |
| `deleteTimer(timerId, sessionId?)` | Removes a timer with optional ownership check |

Model-facing `create_timer` and `update_timer` use shared timer summary formatters that omit the message line; successful receipts retain timer ID, mode/schedule, target and next run. `list_timers` remains the explicit detail query and includes the stored message or concise script source. Message trigger delivery still uses the persisted raw message through `buildTimerTriggeredMessage`; existing message storage and schedule behavior are unchanged.

## Dependencies

- `./config` — `TIMERS_FILE`, `getAgentDir`
- `./common` — `logger`
- `./sessionManager` — catalog-only existence/agent lookup plus `queueSessionSystemEvent`, `queueSessionWaitTimeoutEvent`, and `createSessionInAgentWithAutomaticName`
- `./sessionRuntime` — placement-neutral owner model/node/agent projections for timer create/update defaults
- `./utils/diskJsonData` — `DiskJsonData` (persistent JSON file abstraction)
- `./utils/localTime` — `formatLocalTimestamp`

## Script action contract

The full observable invocation/notification, update/delete, and restart rules are owned by [ToolScript and scheduled work](../behaviors/automation-and-scheduled-work.md#schedule-a-message-or-execute-a-quiet-script). Implementation-specific invariants:

- Persisted records without `action` normalize to message timers. `script` accepts `code`/`filePath`/source `node`, `args`/`argsJson`, `mode`, and `timeoutSecs` through the ordinary starter parser. Action switches clear incompatible payload and new-session settings. The update handler trims the timer ID before both authorization lookup and mutation, so lookup and inherited-action authorization refer to the same record.
- SessionRuntime routes a fixed script command to the exact local/Worker owner, never a Main-hydrated Worker Session. Main retains the live owner's abort slot. Worker admission uses finite cooperative selection-setting safe points with history/admin barriers; no new model-busy checkpoint is persisted.
- `scriptInvocations` reserves one timer invocation synchronously before owner admission can await. Captured-record identity fences completion cleanup for both script and message delivery, including failed delivery; release reschedules an overdue replacement one-time timer.
- `runTimerScriptForOwner` dispatches canonical authorized `run_script` with a fresh enclosing deferred-wait scope, without the model batch executor's caller-turn consumer. Existing run records plus structured timer/run logs retain invocation outcomes. Exact source and newly executed host authorization remain the ordinary ToolScript owners.

## Behavior

- Timers are stored in-memory (`Map`) and persisted to a JSON file on every mutation.
- On `initializeTimers`, past-due one-time timers fire immediately via `setImmediate`; cron timers are re-scheduled. A one-time deadline that crosses after the initial due check but before `node-schedule` accepts the job follows the same immediate-fire path; a null job for a still-future deadline remains invalid.
- `fireTimer` dispatches script actions before message handling. Of the remaining paths, wait-timeout timers deliver via `queueSessionWaitTimeoutEvent` as a pure system event wrapper, while regular timers deliver via `queueSessionSystemEvent` (to existing or newly-created sessions) with the raw timer message wrapped in a single `<foxwarm-message type="timer" ...>...</foxwarm-message>` system part. New-session timers generate/retry names inside the atomic session identity boundary, skipping live and archived candidates.
- `lastTriggeredAt` is written at different attempt/admission boundaries for script and message actions; their user-visible meanings and one-shot cleanup are owned by [invocation completion](../behaviors/automation-and-scheduled-work.md#change-a-schedule-finish-an-invocation-or-restart).
- Input validation enforces allowed characters in `sessionPrefix`, positive timeout values, and exactly one schedule mode for creates / schedule-changing updates.
- `createTimer`/`updateTimer` read owner defaults through SessionRuntime projections without hydrating/saving Worker authority in Main. New-Session model/raw-effort snapshots pass one current models-config snapshot through fire-time pair normalization and creation validation; observable inheritance/drift behavior is owned by [prospective settings](../behaviors/sessions-and-agents.md#prospective-model-and-effort-are-a-pair). Model edits do not add a model-facing timer effort argument. `updateTimer` rejects internal wait-timeout timers, verifies optional ownership scope, and cancels/reschedules the active job so `nextRunAt` reflects the accepted schedule.
- Cron runtime behavior is governed by installed `node-schedule` + `cron-parser`: 5-field and optional-seconds 6-field cron are accepted; `L` works for last day-of-month and last weekday-of-month; `W` is rejected.
- The persistence layer uses `DiskJsonData` with backups disabled for lightweight writes.

## Integration

- Public timer CRUD is triggered through the closed Main Management tool allowlist. Internal wait timeout scheduling enters the same Main-owned timer implementation through its separate fixed `scheduleWaitTimeout` RPC method after canonical wait persistence; it is not another model operation.
- Delivers events back into the session system via `sessionManager`; under Session-worker placement the registered enqueue sink persists them through the exact Worker mailbox instead of mutating a Main stub.
- Can spawn new sessions in a specified agent directory, enabling scheduled autonomous tasks.
- Relies on `config` for file paths and agent directory resolution.
- Automatic timer-session ID allocation follows [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Design Decisions

- [2026-06-29] Add `updateTimer`/`update_timer` so agents can modify timer message, schedule, and new-session target fields without delete+create. Updating must refresh scheduler state and persist atomically; on scheduling failure, restore the previous valid timer/job.
- [2026-06-29] Document and test cron syntax against the actual installed runtime, not stale package README wording: `L` is supported by current `node-schedule`/`cron-parser`, while `W` remains unsupported.
- [2026-07-06/2026-07-07] Timer-fired user content is a source-wrapped inbound event, not a bracketed system header: use one `<foxwarm-message type="timer" timerId="..." mode="..." firedAt="..." localTime="..." hint="...">raw body</foxwarm-message>` system part. Wait timeouts remain pure metadata but carry the human message in the body: `<foxwarm-system kind="event" type="wait-timeout" seconds="...">...</foxwarm-system>`.