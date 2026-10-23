# Unit: Session deletion coordination storage

Files: `dotnet/Foxwarm/Sessions/Storage/SessionDeletionChannels.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionDeletionWorkerStore.cs`

## Purpose

Stores persisted channel attachments and deletion/worker cleanup state used while `SessionManager` claims and drains destructive lifecycle operations.

## Stable methods and callers

The channel store owns the existing `channels.json` payload for normal attachment reads/writes, identity rewrite and deletion cleanup; the worker adapter reads retained Worker ownership and cleans inactive target rows without starting a Worker runtime. `SessionManager.Deletion*` owns selection, claims, stage ordering, and final authority/catalog removal; these files are not an independent deletion authority.

## Contract and side effects

Deletion claims are transient coordination state. The manager must stabilize canonical IDs across concurrent creation, identity move, channel attachment, queue/retry, and busy-start races before applying actual effects. Rejected overlapping operations remain retryable and do not delete Archive audit rows merely because active JSON or catalog cleanup failed. Coordinated Session/WebUI deletion still refuses non-WebUI attachments. The legacy Agent command has its own exact-member channel cleanup that removes all bindings after safe retirement, without relaxing the ordinary caller.

`SessionDeletionWorkerStore` admits the supported version-2 tables, constraints and indexes. `Preflight` refuses non-inactive selected targets. `CleanupInactive` rechecks the schema and exact target state inside its write transaction, deletes only that inactive target's mailbox and ownership rows, and preserves mailbox rows without an ownership row. The adapter does not consume or audit mailbox payloads or validate unrelated ownership/cursor relationships.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionDeletionTests.cs`; `SessionIdentityBoundaryTests.cs`; `SessionIdentityInterleavingTests.cs`.

Normal legacy read/current write, critical versus ordinary binding persistence and shared ingress/delivery callers are mapped in [external channels](./dotnet-external-channels.md). Identity rewrite retains its existing representation-sensitive path rather than normalizing the whole file merely because an identity changes.
