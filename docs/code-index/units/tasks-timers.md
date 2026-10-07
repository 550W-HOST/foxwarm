# Unit: Task service and timer scheduler

Files: `dotnet/Foxwarm/Sessions/TaskService.cs`, `dotnet/Foxwarm/Sessions/TaskStore.cs`, `dotnet/Foxwarm/Timers/CronFields.cs`, `dotnet/Foxwarm/Timers/CronLocalDate.cs`, `dotnet/Foxwarm/Timers/CronSchedule.cs`, `dotnet/Foxwarm/Timers/MainTimers.Crud.cs`, `dotnet/Foxwarm/Timers/MainTimers.Scheduler.cs`, `dotnet/Foxwarm/Timers/MainTimers.Store.cs`, `dotnet/Foxwarm/Timers/TimerArguments.cs`

## Purpose

Persists current task authority/notifications, parses cron schedules, and schedules Main timers with explicit CRUD and restart behavior. This is the current source map; task-phase acceptance is a separate coordination decision.

## Stable methods and callers

- `TaskStore.Execute` owns task records, owner/assignee, parent linkage, status/result/description, notification state, and durable CRUD. The method accepts an optional live `anchorSeq` to create/claim/self-assignment/open/active/reset updates so reminder progress is anchored to the source Session message sequence.
- `TaskService.ExecuteAsync` resolves a live actor anchor when available; tool execution passes `source.Entry.Snapshot().NextMessageSeq - 1`, while the HTTP/API path reads the persisted Session authority anchor and does not hydrate a cold catalog member. Notifications remain service-owned; it does not infer future child-handoff receipts from generic Session send APIs.
- `MainTimers.CreateAsync`, `UpdateAsync`, `MainTimers.Store.LoadAsync`, and the scheduler’s `RunClockAsync` create/update/load and deliver timer records; delivery enqueues the declared Session operation after due-time/schedule validation.
- `CronFields`, `CronLocalDate`, `CronSchedule`, and `TimerArguments.Normalize` own parsing/next-occurrence semantics and argument validation.

Callers: `SessionManager.Tasks/Timers`, `WebUIChannel.Tasks`, timer/task tools, process startup, and WebUI TasksView.

## Contract and side effects

The turn host also marks a terminal tool batch in `ChatResult`; `LocalSessionTurnHost` returns `Terminal=true` and `SessionTurnRunner` exits the outer provider loop before later passive-only follow-up admission can start another provider turn. Runnable/release boundaries still decide whether a later active item should run.

Task authority/service/API/UI work includes legacy Goal migration on owner saves, request-only Task progress, compaction checkpoints, and task-linked child creation. `create_child_session.taskId` preflights and binds a newly created child before initial delivery while sharing the TaskService mutation lane with ordinary task mutators; initial delivery remains outside that lane. Persisted child-handoff boundaries resolve only from consumed canonical queue items or trusted parent-send/attached-task receipts; arbitrary tool/script output is not a receipt. Timer due calculation is persisted and restart-aware; a timer enqueue still follows queue admission semantics and must not be represented as a completed model turn.

## Tests

`dotnet/Foxwarm.Tests/Sessions/TaskStoreTests.cs`; `TaskStoreTests.cs`; `dotnet/Foxwarm.Tests/Timers/*`; WebUI task route tests.
