# Unit: src-timers

Files: src/timers.ts, src/timers.test.ts

## Purpose

Manages scheduled timers that fire messages into sessions — either as one-time events (at a specific timestamp) or recurring (via cron expressions). Timers persist to disk and are re-hydrated on initialization, delivering system events to existing or newly-created sessions when they fire.

## Key Exports

- `SessionTimer` — interface for a stored timer record
- `TimerView` — extended interface adding computed `mode` and `nextRunAt`
- `initializeTimers()` — loads timers from disk and schedules them
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

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `normalizeTimersPayload(raw, filePath)` | ~35 | Validates and normalizes raw JSON from disk |
| `createTimersStore(filePath)` | ~45 | Creates a `DiskJsonData` instance for timer persistence |
| `setTimersStoreForTests(store)` | ~55 | Replaces the timers store and resets state for tests |
| `resetTimersForTests()` | ~62 | Cancels all jobs and clears in-memory timers |
| `generateTimerId()` | ~67 | Produces a random 8-char hex ID |
| `normalizeSessionPrefix(prefix)` | ~71 | Validates and trims session prefix string |
| `buildTriggeredSessionName(prefix)` | ~78 | Generates a unique session name with timestamp and random suffix |
| `setTriggeredSessionNameFactoryForTests(factory)` | ~90 | Overrides generated timer-session names for deterministic allocation tests |
| `isCronTimer(timer)` | ~82 | Checks if a timer has a cron expression |
| `getTimerMode(timer)` | ~86 | Returns `'once'` or `'cron'` |
| `getNextRunAtFromJob(job)` | ~90 | Extracts next invocation timestamp from a node-schedule Job |
| `getNextRunAt(timer)` | ~101 | Computes next run timestamp for any timer |
| `buildTimerTriggeredMessage(timer, firedAt)` | ~112 | Formats fired-timer content as a foxwarm-message wrapper |
| `buildWaitTimeoutMessage(timer)` | ~119 | Formats wait-timeout notification as a foxwarm-system wrapper |
| `toTimerView(timer)` | ~125 | Converts a `SessionTimer` to a `TimerView` |
| `saveTimers()` | ~132 | Persists all timers to disk |
| `cancelTimerJob(timerId)` | ~136 | Cancels a single scheduled job |
| `cancelAllJobs()` | ~143 | Cancels all scheduled jobs |
| `fireTimer(timerId)` | ~148 | Executes timer delivery logic (wait-timeout or session event) |
| `fireTimerForTests(timerId)` | ~265 | Invokes timer delivery deterministically without waiting for the scheduler |
| `scheduleTimer(timer)` | ~210 | Schedules a timer via node-schedule (cron or one-time) |
| `parseAbsoluteTime(at)` | ~245 | Parses a timestamp from number or ISO string |
| `normalizeTimerScheduleArgs(args, options)` | ~315 | Shared create/update validation for mutually exclusive `at` / `afterSeconds` / `cron` schedules |
| `normalizeTimerUpdate(existing, ownerSession, args)` | ~390 | Builds an updated timer record while preserving omitted fields and enforcing new-session-only fields |
| `initializeTimers()` | ~500 | Loads persisted timers from disk and schedules them |
| `createTimer(args)` | ~535 | Validates input, creates, schedules, and persists a new timer |
| `updateTimer(args)` | ~590 | Validates ownership/fields, updates an existing timer, refreshes scheduler state, and rolls back on scheduling errors |
| `createWaitTimeoutTimer(args)` | ~650 | Creates a wait-timeout timer for a session |
| `listTimers(sessionId?)` | ~680 | Filters and sorts active timers into views |
| `deleteTimer(timerId, sessionId?)` | ~695 | Removes a timer with optional ownership check |

## Dependencies

- `./config` — `TIMERS_FILE`, `getAgentDir`
- `./common` — `logger`
- `./sessionManager` — catalog-only existence/agent lookup plus `queueSessionSystemEvent`, `queueSessionWaitTimeoutEvent`, and `createSessionInAgentWithAutomaticName`
- `./sessionRuntime` — placement-neutral owner model/node/agent projections for timer create/update defaults
- `./utils/diskJsonData` — `DiskJsonData` (persistent JSON file abstraction)
- `./utils/localTime` — `formatLocalTimestamp`

## Behavior

- Timers are stored in-memory (`Map`) and persisted to a JSON file on every mutation.
- On `initializeTimers`, past-due one-time timers fire immediately via `setImmediate`; cron timers are re-scheduled.
- `fireTimer` handles two paths: wait-timeout timers deliver via `queueSessionWaitTimeoutEvent` as a pure system event wrapper, while regular timers deliver via `queueSessionSystemEvent` (to existing or newly-created sessions) with the raw timer message wrapped in a single `<foxwarm-message type="timer" ...>...</foxwarm-message>` system part. New-session timers generate/retry names inside the atomic session identity boundary, skipping live and archived candidates.
- One-time timers are deleted after firing or on delivery failure; cron timers persist and only update `lastTriggeredAt`.
- Input validation enforces allowed characters in `sessionPrefix`, positive timeout values, and exactly one schedule mode for creates / schedule-changing updates.
- `createTimer`/`updateTimer` read owner defaults through SessionRuntime projections and never hydrate or save Worker-owned Session authority in Main. `updateTimer` rejects internal wait-timeout timers, verifies optional session ownership scope, preserves omitted fields, supports message/schedule/new-session target edits, and cancels/reschedules the active job so `nextRunAt` reflects the new schedule.
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