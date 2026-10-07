# Unit: Session deletion coordination storage

Files: `dotnet/Foxwarm/Sessions/Storage/SessionDeletionChannels.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionDeletionWorkerStore.cs`

## Purpose

Stores deletion-channel/worker cleanup state used while `SessionManager` claims and drains destructive lifecycle operations.

## Stable methods and callers

The channel store records deletion progress and ownership for the canonical Session identity; the worker store retains cleanup metadata needed when a deletion spans owner/runtime resources. `SessionManager.Deletion*` owns selection, claims, stage ordering, and final authority/catalog removal; these files are not an independent deletion authority.

## Contract and side effects

Deletion claims are transient coordination state. The manager must stabilize canonical IDs across concurrent creation, identity move, channel attachment, queue/retry, and busy-start races before applying actual effects. Rejected overlapping operations remain retryable and do not delete Archive audit rows merely because active JSON or catalog cleanup failed.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionDeletionTests.cs`; `SessionIdentityBoundaryTests.cs`; `SessionIdentityInterleavingTests.cs`.
