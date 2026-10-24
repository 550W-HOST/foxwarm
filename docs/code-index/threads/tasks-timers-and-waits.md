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
- **Owner:** `TaskService` validates task authority/ownership/notifications; `TaskStore` persists task records and the current `anchorSeq` reminder fields; `MainTimers` owns cron scheduling/store/best-effort restart; `SessionSaveLane.Wait` owns declared wait/queue transitions for a Session.
- **Durable boundary:** task store records status/description/owner/assignee/parent/result and current notification state; timer store records schedule/arguments/status; Session JSON records declared waits/queue/busy/stopping. A timer/task enqueue still follows queue admission semantics.
- **Consumers:** WebUI TasksView/list/realtime, task/notification tools, timer scheduler, Session admission/turn runner, and restart bootstrap.

## Ordering and failure behavior

Strict wait/task transitions publish after their store result and preserve committed/accepted status; `MainTimers` enqueues through `AdmitTimerAsync`, which is explicitly best-effort hot-first. Ordinary user queue admission follows the same best-effort path as documented in [save-lane wait](../units/session-save-lane-wait.md). Stop is immediate CTS/state and is not a task/wait persistence operation. Cron parse/next-occurrence errors fail the CRUD request; overdue once delivery does not invent a completed model turn, and cron does not replay missed ticks.

## Current behavior and implementation boundary

The task service anchors reminder progress to live Session message sequence: tool calls use `source.Entry.Snapshot().NextMessageSeq - 1`; API calls read the persisted Session authority next-message anchor without hydrating a cold catalog member. `TaskStore` updates anchor/reset fields on create, claim/self-assignment, open/active, and reset paths, canonicalizing legacy identity references while checkpointing. Legacy Goal values migrate during the owning strict save path; malformed truthy Goal values fail that authority write, while falsy legacy values remain read-compatible. `create_child_session.taskId` performs task preflight, real child creation, and child binding before initial delivery; task completion receipts are consumed at the owner boundary after the tool batch, not inside the task facade. Request-only Task context is consumed per normal provider request/retry, while compaction checkpoints progress without prompt/history/wake rows.

Owner-bound [script timers](../units/tasks-timers.md#owner-bound-toolscript-timers) execute the normal authorized Main-local ToolScript path without model/history activity or caller-turn control. Message timers retain the queue delivery path above.

A consumed canonical queue item updates persisted `childHandoffState`; passive/unconsumed queue items do not. Trusted successful parent sends and attached-task completion resolve that boundary after the tool batch and before the tool result row is appended. A terminal tool batch marks `ChatResult.Terminal`; `LocalSessionTurnHost` stops the outer provider loop and `SessionTurnRunner` handles later runnable/release work without opening a passive-only extra provider turn.

## Canonical units and tests

- [Task service/timers](../units/tasks-timers.md)
- [Wait/queue save operations](../units/session-save-lane-wait.md)
- [Wait-liveness observation and admission](../units/session-domain.md#wait-liveness-observation-and-admission)
- [Session manager services](../units/session-manager-services.md)
- `TaskStoreTests`, `MainTimersStoreTests`, `MainTimerToolsTests`, `SessionAdmissionTests`, and wait/retry tests.
