# Unit: Session manager lifecycle, deletion, and identity moves

Files: `dotnet/Foxwarm/Sessions/SessionManager.Deletion.cs`, `dotnet/Foxwarm/Sessions/SessionManager.DeletionClaims.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IdentityArtifacts.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IdentityMove.cs`, `dotnet/Foxwarm/Sessions/SessionManager.IdentityRecovery.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Lifecycle.cs`

## Purpose

Coordinates create/fork/clear/delete, deletion claims, canonical identity moves, artifact journals, recovery evidence, and lifecycle gate ownership.

## Stable methods and callers

Lifecycle methods claim exact identity/deletion gates before changing owner/store/catalog. Identity move validates Archive reservation/ledger evidence, renames bound artifacts, rebinds save-lane/store identity, and publishes aliases only after committed evidence. Identity move and deletion invalidate the owner-scoped [outbound MCP bindings](./mcp.md#connection-and-cancellation-contract). Delete drains/cancels runtime work, removes active authority/catalog artifacts in declared order, and reports partial cleanup without rewriting immutable Archive history.

## Contract and side effects

Concurrent create/delete/move/queue/busy races resolve through manager claims, not catalog guesses. A registered runner carries a transient exact-entry execution scope through settlement. During host closure, that scope permits its own committed tool/cwd settlement on the ordinary mutation/save lane without reopening processing admission. It is not a long-held mutation lease: normal deletion can still claim a busy target and send Stop before waiting for its owner, and unrelated/new callers remain rejected. Pending/ambiguous identity evidence fails startup or operation closed; historical aliases remain read-only. A post-rename/post-authority failure is reported as committed/partial, never silently compensated by deleting pre-existing Archive rows.

Manual `ForkAsync` and `/fork` share inherited context and exact parent lineage, but do not create a delegated completion duty. The command retains child-style name allocation and sends its initial instruction through ordinary `QueueItem.UserText` ingress before the existing passive parent notice. `CreateChildAsync` retains delegated/task completion contracts. Fork suffixes no longer append a synthetic assistant acknowledgment; copied historical rows, including old acknowledgments, remain unchanged. Fork capture, Archive caps, publication and partial-create receipts still use their original owner/save-lane paths.

## Tests

`SessionIdentityMoveTests.cs`; `SessionIdentityRecoveryTests.cs`; `SessionDeletionTests.cs`; `ForkClearLifecycleTests.cs`; identity interleaving tests.
