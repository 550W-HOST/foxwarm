# Unit: Session save-lane fork, clear, and lifecycle operations

Files: `dotnet/Foxwarm/Sessions/Turns/SessionSaveLane.Lifecycle.cs`

## Purpose

Coordinates history mutation safe points for fork and clear without letting concurrent queue/turn work bypass the owner.

## Stable methods and callers

- `CaptureForkAsync` claims history mutation, captures the queue and the effective Archive block high-water, and stages the child snapshot.
- `DropCapturedQueueAsync` removes only the queue items captured by the fork/clear operation after its ownership is established.
- `ClearHistoryAsync` stages an empty active history with the next sequence/frontier rules, commits through the authority store, and returns a result that distinguishes a clean clear from an aborted/in-progress operation.

Callers: `SessionManager.ForkAsync`, `SessionManager.ClearAsync`, `MessageRouter` `/fork` and `/session clear`, and lifecycle tests. Archive branch creation and child publication are coordinated by the manager and `PersistentSessionAuthorityStore`, not by copying parent Archive rows.

## Contract and side effects

The active JSON history may be replaced or cleared while immutable Archive rows remain. A failure reports whether authority or child delivery was committed; it must not delete a parent Archive row as compensation for a failed child lifetime. Busy/history-mutation conflicts are explicit retryable outcomes.

## Tests

`dotnet/Foxwarm.Tests/Sessions/ForkClearLifecycleTests.cs`; `SessionDeletionTests.cs`; `CommittedArchiveBoundaryTests.cs`; `ArchiveLineageTests.cs`.
