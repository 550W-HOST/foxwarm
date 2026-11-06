# Unit: Session manager tasks, timers, and ToolScript launch

Files: `dotnet/Foxwarm/Sessions/SessionManager.Tasks.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Timers.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ToolScript.cs`

## Purpose

Bridges Main task/timer/ToolScript APIs to the exact Session owner, task service/scheduler, and bounded Main ToolScript runtime.

## Stable methods and callers

Task methods resolve target/actor and pass live/persisted anchor sequence to `TaskService`; timer methods create/update/cancel `MainTimers` records and enqueue declared Session work; ToolScript methods create scoped `ToolScriptContext`, authorize/admit the run, and return run metadata/result through `MainToolScript`.

## Contract and side effects

Task/timer API/UI is implemented, including task-id child attachment, owner-save legacy Goal migration, request-local reminders, compaction checkpoints, and typed child-handoff receipts. Timer enqueue follows best-effort admission semantics. ToolScript host effects still pass authorization/save-lane boundaries; run records are not handoff receipts, while a linked task completion callback is forwarded only within the current foreground/continued execution slice.

Model timer mutations repeat [creation-target policy](./tool-authorization.md#session-creation-agent-targets) inside the existing store `prepare` callback using the same normalized candidate that will be written. This shares generic creation policy without importing `create_session` legacy structural denial; timer isolation and creator-target guards remain independent. The store's existing snapshot-update and literal-owner semantics are unchanged.

## Tests

TaskStore/TaskService, timer scheduler/CRUD, ToolScript launch/record, and Session manager operation tests.
