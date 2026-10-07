# Unit: Session manager tasks, timers, and ToolScript launch

Files: `dotnet/Foxwarm/Sessions/SessionManager.Tasks.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Timers.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ToolScript.cs`

## Purpose

Bridges Main task/timer/ToolScript APIs to the exact Session owner, task service/scheduler, and bounded Main ToolScript runtime.

## Stable methods and callers

Task methods resolve target/actor and pass live/persisted anchor sequence to `TaskService`; timer methods create/update/cancel `MainTimers` records and enqueue declared Session work; ToolScript methods create scoped `ToolScriptContext`, authorize/admit the run, and return run metadata/result through `MainToolScript`.

## Contract and side effects

Task/timer API/UI is implemented, including task-id child attachment, owner-save legacy Goal migration, request-local reminders, compaction checkpoints, and typed child-handoff receipts. Timer enqueue follows best-effort admission semantics. ToolScript host effects still pass authorization/save-lane boundaries; run records are not handoff receipts, while a linked task completion callback is forwarded only within the current foreground/continued execution slice.

## Tests

TaskStore/TaskService, timer scheduler/CRUD, ToolScript launch/record, and Session manager operation tests.
