# Unit: Session owner, runtime, and turn runner

Files: `dotnet/Foxwarm/Sessions/SessionOwner.Requests.cs`, `dotnet/Foxwarm/Sessions/SessionOwner.cs`, `dotnet/Foxwarm/Sessions/SessionRuntime.cs`, `dotnet/Foxwarm/Sessions/SessionRuntimeState.cs`, `dotnet/Foxwarm/Sessions/Turns/LocalSessionTurnHost.Tools.cs`, `dotnet/Foxwarm/Sessions/Turns/LocalSessionTurnHost.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionControl.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionEntry.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionIngress.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionRegistry.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTestDoubles.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTurnRunner.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTypes.cs`, `dotnet/Foxwarm/Sessions/Turns/TurnContracts.cs`

## Purpose

Owns one Session's mutable state, exact-owner runtime operations, serialized turn execution, queue ingress, stop/dequeue controls, and model/tool turn contracts. Persistence ordering belongs to the save-lane and authority-store units linked below.

## Stable methods and callers

- `SessionRuntime.GetOwnerAsync`, `SubmitAndRunAsync`, `ContinueAsync`, `StopAsync`, `DequeueAsync`, `ForkCommandAsync`, and clear/control methods resolve the canonical owner and return typed lifecycle outcomes.
- `SessionOwner` exposes the owner metadata/state boundary and coordinates model request, tool loop, compaction, waits, and publication callbacks. `ExecutionNode` uses the manager's shared placement resolver with the owner's current Agent binding; `BuildDto` projects that effective Node and unchanged stored cwd for composer responses and realtime snapshots. Snapshot history uses the same resolver through [the WebUI contract](./dotnet-webui-core.md), including retained authority without a selection field. These reads do not save or manufacture authority fields.
- `SessionEntry.TryClaimProcessor`, `MarkBusy`, `BeginStop`, `ReleaseBusy`, and `Snapshot` guard live state and processor ownership under `stateGate`.
- `SessionIngress.EnqueueAsync` validates supported queue kinds, forces trigger semantics at the ingress boundary, admits through `SessionSaveLane`, and triggers the runner only when the owner is runnable.
- `SessionTurnRunner.ProcessQueueAsync` claims one processor, runs `LocalSessionTurnHost`, appends canonical messages through the save lane, and finalizes busy/stopping state. `LocalSessionTurnHost` applies child-handoff state for consumed queue items during canonical append, resolves trusted send/task receipts before tool-row append, reads parent identity through the Main catalog-overlay resolver for child reminders and receipt handling, recognizes terminal `NO_ACTION` signals across text parts only when no continuation is possible, queues repeated unresolved-child reminders without a history-window suppression, and stops the outer loop after terminal tool batches.
- `LocalSessionTurnHost.ContinueAfterResultAsync` delegates continuation maintenance to the owner's compactor while retaining both queued-input safe points. The owner supplies failure propagation and compact commit outcomes; ordinary provider-time queued input and complete tool batches share this path. The turn cancellation token releases a required-compaction wait without cancelling independent planning.
- `SessionControl.StopAsync`/`DequeueAsync` signal cancellation and await the owner safe point rather than mutating queue state out of band.

Callers: `MessageRouter`, `SessionManager`, WebUI route handlers, task/timer tools, and model/tool services. The exact owner remains authoritative even when a route only needs a catalog projection.

## Contract and side effects

History snapshots capture the immutable root described in [history ownership](./session-domain.md#history-ownership); they do not clone the complete history. Canonical append stages new owned records and shares existing records. Read-only model selection, prompt/cache lookup, task visibility, and under-threshold continuation use narrow gated reads. The turn host explicitly materializes JSON at the mutable `IChatService` boundary. Committed notifications inspect immutable sequences before projecting only newly delivered records.

One processor claim may run per Session. Busy and stopping are distinct state: restart recovery can clear stale busy ownership, while stopping is an explicit lifecycle/control outcome. Queue admission persists before triggering; passive inter-Session items remain durable without automatically starting a turn. Stop can abort an in-flight request/tool loop but must still await the final authoritative save result.

Tool execution carries source JSON values; ordinary history projection and trusted receipts follow [the tool contract](../threads/tools-permissions-and-exec.md#outbound-mcp-values-and-trusted-control).

Completed provider usage updates the existing authority `stats` totals and `lastUsage` in the same ordered canonical append transaction as its assistant row. The explicit result usage takes precedence over normalized message metadata; tool rows, unrelated input and ordinary saves do not recount history. A usage-only completion persists totals without inventing an assistant row. Pre-commit failure leaves hot totals unchanged; post-commit failure publishes the committed totals. Existing Session/catalog projections feed cumulative usage consumers without an additional stats API.

The turn runner does not write raw JSON or Archive directly. It stages snapshots and canonical rows through [the save lane](./session-save-lane-core.md) and [the authority store](./session-authority-store.md), preserving pre/post-rename failure classification.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionTurnTests.cs`; `PersistentSessionTurnTests.cs`; `SessionAdmissionTests.cs`; `RetryInputSafePointTests.cs`; `SessionExecutionEnvironmentTests.cs`; `SessionWait` and `SessionIdentityInterleaving` coverage; `CompactContinuationTests.cs`; `SessionUsageTests.cs` (cumulative usage, metadata/explicit usage, usage-only completions, reopen and pre/post-commit boundaries).
