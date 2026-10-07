# Unit: Session owner, runtime, and turn runner

Files: `dotnet/Foxwarm/Sessions/SessionOwner.Requests.cs`, `dotnet/Foxwarm/Sessions/SessionOwner.cs`, `dotnet/Foxwarm/Sessions/SessionRuntime.cs`, `dotnet/Foxwarm/Sessions/SessionRuntimeState.cs`, `dotnet/Foxwarm/Sessions/Turns/LocalSessionTurnHost.Tools.cs`, `dotnet/Foxwarm/Sessions/Turns/LocalSessionTurnHost.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionControl.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionEntry.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionIngress.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionRegistry.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTestDoubles.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTurnRunner.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTypes.cs`, `dotnet/Foxwarm/Sessions/Turns/TurnContracts.cs`

## Purpose

Owns one Session's mutable state, exact-owner runtime operations, serialized turn execution, queue ingress, stop/dequeue controls, and model/tool turn contracts. Persistence ordering belongs to the save-lane and authority-store units linked below.

## Stable methods and callers

- `SessionRuntime.GetOwnerAsync`, `SubmitAndRunAsync`, `ContinueAsync`, `StopAsync`, `DequeueAsync`, `ForkCommandAsync`, and clear/control methods resolve the canonical owner and return typed lifecycle outcomes.
- `SessionOwner` exposes the owner metadata/state boundary and coordinates model request, tool loop, compaction, waits, and publication callbacks.
- `SessionEntry.TryClaimProcessor`, `MarkBusy`, `BeginStop`, `ReleaseBusy`, and `Snapshot` guard live state and processor ownership under `stateGate`.
- `SessionIngress.EnqueueAsync` validates supported queue kinds, forces trigger semantics at the ingress boundary, admits through `SessionSaveLane`, and triggers the runner only when the owner is runnable.
- `SessionTurnRunner.ProcessQueueAsync` claims one processor, runs `LocalSessionTurnHost`, appends canonical messages through the save lane, and finalizes busy/stopping state. `LocalSessionTurnHost` applies child-handoff state for consumed queue items during canonical append, resolves trusted send/task receipts before tool-row append, recognizes terminal `NO_ACTION` signals only when no continuation is possible, and stops the outer loop after terminal tool batches.
- `SessionControl.StopAsync`/`DequeueAsync` signal cancellation and await the owner safe point rather than mutating queue state out of band.

Callers: `MessageRouter`, `SessionManager`, WebUI route handlers, task/timer tools, and model/tool services. The exact owner remains authoritative even when a route only needs a catalog projection.

## Contract and side effects

One processor claim may run per Session. Busy and stopping are distinct state: restart recovery can clear stale busy ownership, while stopping is an explicit lifecycle/control outcome. Queue admission persists before triggering; passive inter-Session items remain durable without automatically starting a turn. Stop can abort an in-flight request/tool loop but must still await the final authoritative save result.

The turn runner does not write raw JSON or Archive directly. It stages snapshots and canonical rows through [the save lane](./session-save-lane-core.md) and [the authority store](./session-authority-store.md), preserving pre/post-rename failure classification.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionTurnTests.cs`; `PersistentSessionTurnTests.cs`; `SessionAdmissionTests.cs`; `RetryInputSafePointTests.cs`; `SessionExecutionEnvironmentTests.cs`; `SessionWait` and `SessionIdentityInterleaving` coverage.
