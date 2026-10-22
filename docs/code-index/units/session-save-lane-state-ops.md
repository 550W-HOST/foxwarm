# Unit: Session save-lane settings, prompt cache, goals, retry, and compact wake state

Files: dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Cache.cs, dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Compact.cs, dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Cwd.cs, dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Retry.cs, dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Settings.cs, dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Selection.cs, dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Vector.cs

Primary source: dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.cs

## Purpose

Provides narrow save-lane operations for fields that are still part of active Session authority: prompt-cache keys, compact wake records, cwd, retry notices, model/settings patches, compact threshold updates, and migration of historical Goal state during an owning save.

## Stable methods and callers

- `AdoptEffectiveSelectionAsync` stages normal-attempt baseline metadata and any canonical settings notice together, publishing the committed outcome without rolling back postcommit failures. Unchanged baselines do not write again; setters do not produce notices.
- `EnsurePromptCacheKeyAsync` persists a generated/reused prefix key through the lane rather than changing it concurrently with history.
- `PublishCompactWakeAsync`, `RemoveCompactWakeAsync`, and `ReleaseStandaloneCompactAsync` keep ready/standalone compact markers ordered with ordinary saves.
- `CommitCwdAsync`, `CommitRetryNoticeAsync`, and `CommitSettingsAsync` each stage a narrow authority envelope change and publish only after the store result. `SessionSaveLane` invokes the TaskService legacy-Goal migration hook for staged owner saves, including best-effort queue admission and strict identity pre-save; invalid truthy Goal values block the write, while valid migration removes the legacy field after the task transaction commits.

- `CommitCwdAsync` also accepts the provider exec caller's opaque-whitespace mode and exact-owner/Node condition, checked inside the ordered lane. Native/settings cwd normalization is unchanged; [provider exec](./tools-local-io.md#provider-exec) owns that caller contract.

- `CommitVectorIndexPositionAsync` publishes legacy index-position compatibility fields only after explicit force indexing succeeds; it uses the same ordered authority commit and does not make the derived index an authority.

Callers: SessionManager settings/goal/timer operations, SessionOwner retry/compaction hooks, and the model request preparation path.

## Contract and side effects

Existing prompt-cache keys are read without capturing history. Retry append/replacement stages an immutable record and shares unchanged history, publishing only after the same strict store result. Model settings patches validate against the host's model configuration before publication; the verbose flag uses the same strict settings lane and requires a boolean. Retry notices are persisted as model-visible history metadata through the same canonical ordering; they do not create child-handoff receipts. Compact wake cleanup is wait-neutral and must not clear a declared Session wait accidentally.

For `compactThresholdTokens`, the settings lane accepts null to clear or a finite positive number, then floors that supplied number before saving. Invalid supplied values fail before authority mutation. Callers retain their own normalization: the slash command already floors token/unit input, so `0.9` reaches settings as zero and is rejected without replacing a saved override. The threshold tool forwards positive numeric input unfloored; its `0.9` therefore still saves zero, whose effective threshold inherits the model default. Absent/nonpositive tool input remains inspection rather than a settings patch.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionCwdCommitTests.cs`; `SessionPresentationTests.cs`; `EffectiveSelectionTests.cs`; `RetryNoticeTests.cs`; `RetryInputSafePointTests.cs`; `CompactLifecycleTests.cs`; `GoalPersistenceBoundaryTests.cs`.
