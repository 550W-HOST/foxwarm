# Unit: Session manager lifecycle, deletion, and identity moves

Files: `dotnet/Foxwarm/Sessions/SessionManager.Deletion.cs`, `dotnet/Foxwarm/Sessions/SessionManager.DeletionClaims.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IdentityArtifacts.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IdentityMove.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IdentityRecovery.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Lifecycle.cs`

## Purpose

Coordinates create/fork/clear/delete, deletion claims, canonical identity moves, artifact journals, recovery evidence, and lifecycle gate ownership.

## Stable methods and callers

Lifecycle methods claim exact identity/deletion gates before changing owner/store/catalog. Identity move validates Archive reservation/ledger evidence, renames bound artifacts, rebinds save-lane/store identity, and publishes aliases only after committed evidence. Delete drains/cancels runtime work, removes active authority/catalog artifacts in declared order, and reports partial cleanup without rewriting immutable Archive history.

## Contract and side effects

Concurrent create/delete/move/queue/busy races resolve through manager claims, not catalog guesses. Pending/ambiguous identity evidence fails startup or operation closed; historical aliases remain read-only. A post-rename/post-authority failure is reported as committed/partial, never silently compensated by deleting pre-existing Archive rows.

## Tests

`SessionIdentityMoveTests.cs`; `SessionIdentityRecoveryTests.cs`; `SessionDeletionTests.cs`; `ForkClearLifecycleTests.cs`; identity interleaving tests.
