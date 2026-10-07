# Unit: Session wait and queue admission save operations

Files: `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Wait.cs`

## Purpose

Persists queue admission and declared waits while preserving passive/trigger behavior, timeout identity, and strict wait-state transitions.

## Stable methods and callers

- `AdmitAsync`, `AdmitWithReceiptAsync`, and `AdmitTimerAsync` append supported queue items to active JSON and return whether the item was newly admitted.
- `StartWaitAsync`, `ClearWaitAsync`, and `MutateWaitAsync` validate one wait declaration, update wait metadata, flush deferred items when required, and preserve stale-token protection.
- `CommitWaitSnapshotAsync` publishes a wait-aware snapshot through the authority store; `PublishMeta` keeps metadata updates narrow.

Callers: `SessionIngress`, `SessionManager` wait operations, timer tools, and WebUI wait/task routes. The turn runner triggers processing only after admission reports a runnable item and the owner is neither busy nor stopping.

## Contract and side effects

Ingress forces trusted trigger state at the boundary; callers cannot smuggle a passive marker through the public queue API. Ordinary `AdmitAsync` uses a best-effort queue admission path: it publishes the new queue item to hot state before attempting persistence, records a write failure, and returns no durable-completion guarantee to the HTTP caller. Strict admissions such as canonical inter-Session and selected wait transitions publish only after the store result and preserve `AuthorityCommittedException` semantics; `AdmitTimerAsync` is explicitly `SaveKind.BestEffort` and remains hot-first.

Stop is intentionally different from queue admission. `SessionControl.StopAsync` takes the immediate owner cancellation/CTS path (`SessionEntry.BeginStop` and `SessionSaveLane` stop state) so the current request can be interrupted before a persistence tail completes; the later save/finalization must not let a stale snapshot overwrite the stopping/queue outcome. Wait clearing can release deferred queue items as one ordered transition. A committed wait survives restart through active JSON; transient requesting-model/running-tool phases do not become persisted waits.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionAdmissionTests.cs`; `PersistentSessionTurnTests.cs`; `RetryNoticeTests.cs`; `dotnet/Foxwarm.Tests/Timers/MainTimerToolsTests.cs`.
