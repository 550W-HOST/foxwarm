# Unit: src-timers

Files: src/timers.ts, src/timerScript.ts, src/timers.test.ts, src/timerScript.test.ts, src/timerWorker.test.ts

## Purpose

Manages scheduled timers that deliver messages or execute owner-bound ToolScript — either as one-time events (at a specific timestamp) or recurring (via cron expressions). Timers persist to disk and are re-hydrated on initialization. Message timers deliver system events to existing or newly-created Sessions; script timers invoke their existing owner without automatic message delivery.

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

- Persisted records without `action` remain message timers. Public script timers belong to the calling canonical Session; message targeting cannot grant cross-owner code execution. A supplied `script` replaces the entire specification; action switches clear incompatible payload and new-session settings.
- `script` accepts ordinary `code`/`filePath`/source `node`, `args`/`argsJson`, `mode`, and `timeoutSecs`. Registration normalizes intent without source I/O; firing resolves current owner routing, reauthorizes the starter and source read, rereads complete file source, and dispatches the normal `run_script`. Source selection does not move the VM or nested default Node.
- SessionRuntime routes a fixed script command to the exact local/Worker owner, never a model queue or Main-hydrated Worker Session. Main runs against its live owner even during a model request, without registering over its abort slot. Worker scripts share finite cooperative selection-setting safe points, retaining history/admin barriers; one unreturned provider/tool await can delay a tick. No new model-busy checkpoint is persisted.
- One initial slice per timer may be in flight, including owner admission. Overlapping cron ticks are skipped without backlog or catch-up. Completion, failure, or pause ends the invocation; cron continues, while one-time timers are removed. Captured-record identity prevents an old invocation from deleting an updated timer; an overdue replacement one-time timer is rescheduled on release. Delete stops future ticks, not prior effects.
- Firing does not append history or automatically request a model, notify errors, or resume paused snapshots. Existing ToolScript records and structured timer/run logs remain diagnostic authority. The unattended root shares the existing deferred-wait scope but has no calling model turn to stop/wait; explicit tool effects and one-shot model calls remain ordinary. In particular, background exec completion can still wake the Session.
- Existing restart scheduling remains best effort: due once fires, cron schedules its next tick, and no missed cron replay or exactly-once guarantee is added. Saved checkpoints remain manually inspectable/continuable through the ordinary ToolScript tools.

## Behavior

- Timers are stored in-memory (`Map`) and persisted to a JSON file on every mutation.
- On `initializeTimers`, past-due one-time timers fire immediately via `setImmediate`; cron timers are re-scheduled. A one-time deadline that crosses after the initial due check but before `node-schedule` accepts the job follows the same immediate-fire path; a null job for a still-future deadline remains invalid.
- `fireTimer` handles two paths: wait-timeout timers deliver via `queueSessionWaitTimeoutEvent` as a pure system event wrapper, while regular timers deliver via `queueSessionSystemEvent` (to existing or newly-created sessions) with the raw timer message wrapped in a single `<foxwarm-message type="timer" ...>...</foxwarm-message>` system part. New-session timers generate/retry names inside the atomic session identity boundary, skipping live and archived candidates.
- One-time timers are deleted after firing or on delivery failure; cron timers persist. Script `lastTriggeredAt` records an attempted invocation, including failure/pause; message delivery retains its existing successful-delivery meaning.
- Input validation enforces allowed characters in `sessionPrefix`, positive timeout values, and exactly one schedule mode for creates / schedule-changing updates.
- `createTimer`/`updateTimer` read owner defaults through SessionRuntime projections and never hydrate or save Worker-owned Session authority in Main. New-session timers snapshot model plus raw effort together. At fire time that persisted pair is inherited state, so it is re-normalized against one current models-config snapshot: compatible effort and virtual-union support remain stored on the child, while config-drift incompatibility clears to unset/default instead of failing delivery. Model edits likewise preserve compatible effort or clear incompatible effort without adding a model-facing timer effort argument. `updateTimer` rejects internal wait-timeout timers, verifies optional session ownership scope, preserves omitted fields, supports message/schedule/new-session target edits, and cancels/reschedules the active job so `nextRunAt` reflects the new schedule.
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