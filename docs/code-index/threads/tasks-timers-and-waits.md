# Thread: Tasks, timers, waits, and notifications

## Producer to consumer path

```text
WebUI/task tool/timer creation or Session wait request
  -> SessionManager.Tasks/Timers/Wait
  -> TaskService/TaskStore or MainTimers or SessionSaveLane.Wait
  -> task/timer/Session JSON authority + notification event
  -> WebUI TasksView/realtime or Session owner turn admission
```

- **Producers:** `WebUIChannel.Tasks`, task/timer/wait tool definitions, `SessionManager`, and `MainTimers` CRUD receive explicit owner/session/task arguments.
- **Owner:** `TaskService` validates task authority/ownership/notifications; `TaskStore` persists task records and the accepted 7A live `anchorSeq` reminder fields; `MainTimers` owns cron scheduling/store/restart catch-up; `SessionSaveLane.Wait` owns declared wait/queue transitions for a Session.
- **Durable boundary:** task store records status/description/owner/assignee/parent/result and current notification state; timer store records schedule/arguments/status; Session JSON records declared waits/queue/busy/stopping. A timer/task enqueue still follows queue admission semantics.
- **Consumers:** WebUI TasksView/list/realtime, task/notification tools, timer scheduler, Session admission/turn runner, and restart bootstrap.

## Ordering and failure behavior

Strict wait/task transitions publish after their store result and preserve committed/accepted status; `MainTimers` enqueues through `AdmitTimerAsync`, which is explicitly best-effort hot-first. Ordinary user queue admission follows the same best-effort path as documented in [save-lane wait](../units/session-save-lane-wait.md). Stop is immediate CTS/state and is not a task/wait persistence operation. Cron parse/next-occurrence errors fail the CRUD request; scheduler retry/catch-up does not invent a completed model turn.

## Accepted 7A behavior and current qualification boundary

The accepted 7A task delta anchors reminder progress to live Session message sequence: tool calls use `source.Entry.Snapshot().NextMessageSeq - 1`; API calls read the persisted Session authority next-message anchor without hydrating a cold catalog member. `TaskStore` updates anchor/reset fields on create, claim/self-assignment, open/active, and reset paths. A terminal tool batch marks `ChatResult.Terminal`; `LocalSessionTurnHost` stops the outer provider loop and `SessionTurnRunner` handles later runnable/release work without opening a passive-only extra provider turn.

Legacy Goal migration/retirement, request-local task reminders beyond the accepted anchor fields, `create_child_session.taskId` attachment, and creator-send/attached-child completion receipts remain unimplemented consumers. Existing child-reminder text handling is not a persisted receipt implementation.

## Canonical units and tests

- [Task service/timers](../units/tasks-timers.md)
- [Wait/queue save operations](../units/session-save-lane-wait.md)
- [Session manager services](../units/session-manager-services.md)
- `TaskStoreTests`, `MainTimersStoreTests`, `MainTimerToolsTests`, `SessionAdmissionTests`, and wait/retry tests.
