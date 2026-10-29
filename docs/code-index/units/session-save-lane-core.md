# Unit: Session save-lane core

Files: `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.cs`
Secondary files: `dotnet/Foxwarm.Tests/Sessions/CanonicalNotificationOwnershipTests.cs`

## Purpose

**Implementation owner.** Implements the [ordered save lane](../threads/session-ownership-and-persistence.md#ordered-save-lane) and [commit/failure boundary](../threads/session-ownership-and-persistence.md#canonical-append-ordering-and-errors). Caller-specific admission and already-committed effects constrain changes; a convenient helper abstraction cannot strengthen or weaken their guarantees implicitly.

Serializes all persistence operations for one `SessionEntry` through a task tail. It is the owner-side ordering boundary, not a second state authority.

## Stable methods and callers

- `SaveStrictAsync` and `SaveBestEffortAsync` persist ordinary snapshots with distinct failure semantics.
- `CommitCanonicalAppendAsync` stages canonical history and delegates Archive-first publication to `PersistentSessionAuthorityStore`. Its result-bearing counterpart retains the exact appended rows; ordinary appends publish those rows, while queue appends suppress individual notifications and use their dedicated batch owner.
- `CommitCompactionAsync` stages compacted history/blocks and delegates the same durable ordering while optionally refreshing the memory snapshot.
- `CommitMemorySnapshotAsync`, `CommitDisplayNameAsync`, `CommitInterSessionAsync`, and `CommitBackgroundExecCompletionAsync` make specialized state changes join the same tail.
- `MutateIdentityAsync` and `RetireAsync` ensure identity changes/store close cannot overlap an earlier write.

## Contract and side effects

`EnqueueOperationAsync` waits for the prior task but catches a prior failure before running the next operation, so a failed best-effort write does not poison strict persistence. Publication depends on the operation kind: strict canonical/compaction/setting paths publish after the store result, while ordinary queue admission in `SessionSaveLane.Wait.cs` intentionally updates hot queue state before attempting its `SaveKind.BestEffort` write; a best-effort failure is recorded and the hot input remains queued even though the caller must not claim durable completion. `AuthorityCommittedException` publishes staged strict state because the JSON rename already occurred. Scoped browser ingress may supply a final live assertion inside the same ordered lane, after asynchronous image preparation and before hot queue admission; rejection adds no input and does not redefine ordinary best-effort durability. Already-admitted input is not retracted. A retired lane rejects new operations and closes the store after its predecessor drains.

Notifications belong to the append, not a scan of later history. Settings/state saves do not discover rows for another append. Exact-row delivery remains post-commit and outside the persistence tail; it does not create a new serialization or durability guarantee. Ordinary notice and selection callers retain their existing committed-error presentation, while a thrown queue/model canonical save still aborts that caller without claiming a successful batch.

`FailedOperation` recognizes an exception, including a wrapped cause, from this exact lane using weak error-identity attribution. Failure presentation uses it only to avoid sending another semantic append down the failed authority path. It neither poisons later independent saves nor changes operation/commit/rollback ordering.

## Tests

`dotnet/Foxwarm.Tests/Sessions/CanonicalNotificationOwnershipTests.cs` checks the supported settings/queue and delayed ordinary-notice continuations plus cold-load non-replay. `dotnet/Foxwarm.Tests/Sessions/PersistentSessionTurnTests.cs`; `RetryInputSafePointTests.cs`; `SessionCwdCommitTests.cs`; `SessionPresentationTests.cs`.

Canonical usage append also accumulates optional `stats.totalCost` from present `usage.cost` and clones the full `lastUsage` at the same staged/publication boundary as tokens. Missing cost leaves the recorded subtotal unchanged; see [D-model-usage-cost](../threads/model-request-and-streaming.md#d-model-usage-cost).
