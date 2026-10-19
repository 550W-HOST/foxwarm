# Unit: Session save-lane fork, clear, selective deletion, and lifecycle operations

Files: `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Lifecycle.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.DeleteMessages.cs`

## Purpose

Coordinates history mutation safe points for fork and clear without letting concurrent queue/turn work bypass the owner.

## Stable methods and callers

- `CaptureForkAsync` claims history mutation, captures the queue and the effective Archive block high-water, and stages the child snapshot.
- `DropCapturedQueueAsync` removes only the queue items captured by the fork/clear operation after its ownership is established.
- `ClearHistoryAsync` stages an empty active history with the next sequence/frontier rules, commits through the authority store, and returns a result that distinguishes a clean clear from an aborted/in-progress operation.

- `DeleteMessagesAsync` stages an oldest/newest active slice with a new history version and legacy indexing-position updates. It preserves next message/block identities, queue/busy/Stop state and committed Archive rows. It joins ordinary canonical writes through the lane without claiming the fork/clear history-mutation gate.

Callers: `/delete-messages`, `SessionManager.ForkAsync`, `SessionManager.ClearAsync`, `MessageRouter` `/fork` and `/session clear`, and lifecycle tests. Archive branch creation and child publication are coordinated by the manager and `PersistentSessionAuthorityStore`, not by copying parent Archive rows.

## Contract and side effects

The active JSON history may be replaced or cleared while immutable Archive rows remain. A failure reports whether authority or child delivery was committed; it must not delete a parent Archive row as compensation for a failed child lifetime. Fork/clear busy/history-mutation conflicts remain explicit retryable outcomes. Selective deletion instead uses the existing strict pre/post-rename publication truth and permits ordinary concurrent turn work; it is not Archive deletion.

## Tests

`dotnet/Foxwarm.Tests/Sessions/ForkClearLifecycleTests.cs`; `SessionDeletionTests.cs`; `CommittedArchiveBoundaryTests.cs`; `ArchiveLineageTests.cs`.
