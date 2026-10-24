# Unit: Session wait and queue admission save operations

Files: `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Wait.cs`

## Purpose

Persists queue admission and declared waits while preserving passive/trigger behavior, timeout identity, and strict wait-state transitions.

## Stable methods and callers

- `AdmitAsync`, `AdmitWithReceiptAsync`, and `AdmitTimerAsync` append supported queue items to active JSON and return whether the item was newly admitted.
- `StartWaitAsync`, `ClearWaitAsync`, and `MutateWaitAsync` validate one wait declaration, update wait metadata, flush deferred items when required, and preserve stale-token protection.
- `CommitRemoteExecCompletionAsync` stages the remote deterministic receipt and queue item in one strict save; the newest 32 accepted IDs bound deduplication. Committed-but-unsynced receipt retries finish strict durability without another queue insertion or wake.
- `CommitWaitSnapshotAsync` publishes a wait-aware snapshot through the authority store; `PublishMeta` keeps metadata updates narrow.

Callers: `SessionIngress`, `SessionManager` wait operations, timer tools, authenticated remote exec completion, and WebUI wait/task routes. The turn runner triggers processing only after admission reports a runnable item and the owner is neither busy nor stopping.

## Contract and side effects

Ingress forces trusted trigger state at the boundary; callers cannot smuggle a passive marker through the public queue API. Ordinary `AdmitAsync` uses a best-effort queue admission path: it publishes the new queue item to hot state before attempting persistence, records a write failure, and returns no durable-completion guarantee to the HTTP caller. Legacy Goal migration is staged in the same owner save; a post-rename `AuthorityCommittedException` still publishes the cleared hot Goal before the best-effort failure is recorded. Strict admissions such as canonical inter-Session and selected wait transitions publish only after the store result and preserve `AuthorityCommittedException` semantics; `AdmitTimerAsync` is explicitly `SaveKind.BestEffort` and remains hot-first.

Stop is intentionally different from queue admission. `SessionControl.StopAsync` takes the immediate owner cancellation/CTS path (`SessionEntry.BeginStop` and `SessionSaveLane` stop state) so the current request can be interrupted before a persistence tail completes; the later save/finalization must not let a stale snapshot overwrite the stopping/queue outcome. Wait clearing can release deferred queue items as one ordered transition. Trusted passive `trigger:false` rows and compact wakes neither clear waits nor satisfy wait-all targets. Task previous-owner notices retain this state and their existing notification deduplication. Explicit dequeue clears the wait through the same lane before starting passive-only work. Stale timeout IDs and diagnostic `waitLivenessWaitId` values remain ineffective, including when queued fast replies are reapplied to a replacement wait; ordinary ingress still forces triggering. Historical diagnostic fingerprints do not participate in admission.

A committed wait survives restart through active JSON; transient requesting-model/running-tool phases do not become persisted waits. Persisted/internal `waitAll.sessions` accepts a nonempty single-target list, matching Source's existing wait writer and transition contract. Normal hydration, save and reopen preserve the original wait and absent `declarationVersion`; they do not convert it to wait-any or enroll it in current declaration/quiescence semantics. New model-facing wait-all declarations still require at least two distinct accessible non-self targets through `SessionManager.ValidateWait`, separately from persisted-state validation.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionAdmissionTests.cs`; `PersistentSessionTurnTests.cs`; `PassiveTaskInputTests.cs`; `RetryNoticeTests.cs`; `WaitLivenessTests.cs`; `LegacyWaitAuthorityTests.cs` with actual Source fixture `dotnet/legacy-wait-fixture-ts.mjs`; `dotnet/Foxwarm.Tests/Timers/MainTimerToolsTests.cs`.
