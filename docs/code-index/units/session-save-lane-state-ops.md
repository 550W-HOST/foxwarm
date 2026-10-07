# Unit: Session save-lane settings, prompt cache, goals, retry, and compact wake state

Files: `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Cache.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Compact.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Cwd.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Goal.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Retry.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Settings.cs`

## Purpose

Provides narrow save-lane operations for fields that are still part of active Session authority: prompt-cache keys, compact wake records, cwd, goal/interval state, retry notices, model/settings patches, and compact threshold updates.

## Stable methods and callers

- `EnsurePromptCacheKeyAsync` persists a generated/reused prefix key through the lane rather than changing it concurrently with history.
- `PublishCompactWakeAsync`, `RemoveCompactWakeAsync`, and `ReleaseStandaloneCompactAsync` keep ready/standalone compact markers ordered with ordinary saves.
- `CommitCwdAsync`, `SetGoalAsync`, `AppendGoalReminderAsync`, `CommitRetryNoticeAsync`, and `CommitSettingsAsync` each stage a narrow authority envelope change and publish only after the store result.

Callers: SessionManager settings/goal/timer operations, SessionOwner retry/compaction hooks, and the model request preparation path. Legacy Goal migration or future task-reminder consumers are not inferred from these current field operations.

## Contract and side effects

Settings patches validate against the host's model configuration before publication. Retry notices are persisted as model-visible history metadata through the same canonical ordering; they do not create child-handoff receipts. Compact wake cleanup is wait-neutral and must not clear a declared Session wait accidentally.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionCwdCommitTests.cs`; `SessionPresentationTests.cs`; `RetryNoticeTests.cs`; `RetryInputSafePointTests.cs`; `CompactLifecycleTests.cs`; `SessionGoal` coverage in SessionManager tests.
