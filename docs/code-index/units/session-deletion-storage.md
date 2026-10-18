# Unit: Session deletion coordination storage

Files: `dotnet/Foxwarm/Sessions/Storage/SessionDeletionChannels.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionDeletionWorkerStore.cs`

## Purpose

Stores persisted channel attachments and deletion/worker cleanup state used while `SessionManager` claims and drains destructive lifecycle operations.

## Stable methods and callers

The channel store owns the existing `channels.json` payload for normal attachment reads/writes, identity rewrite and deletion cleanup; the worker store retains cleanup metadata needed when a deletion spans owner/runtime resources. `SessionManager.Deletion*` owns selection, claims, stage ordering, and final authority/catalog removal; these files are not an independent deletion authority.

## Contract and side effects

Deletion claims are transient coordination state. The manager must stabilize canonical IDs across concurrent creation, identity move, channel attachment, queue/retry, and busy-start races before applying actual effects. Rejected overlapping operations remain retryable and do not delete Archive audit rows merely because active JSON or catalog cleanup failed.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionDeletionTests.cs`; `SessionIdentityBoundaryTests.cs`; `SessionIdentityInterleavingTests.cs`.

Normal legacy read/current write, critical versus ordinary binding persistence and shared ingress/delivery callers are mapped in [external channels](./dotnet-external-channels.md). Identity rewrite retains its existing representation-sensitive path rather than normalizing the whole file merely because an identity changes.
