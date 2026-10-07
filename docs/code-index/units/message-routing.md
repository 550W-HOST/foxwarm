# Unit: Message routing and presentation commands

Files: `dotnet/Foxwarm/MessageRouter.Deletion.cs`, `dotnet/Foxwarm/MessageRouter.IdentityMove.cs`, `dotnet/Foxwarm/MessageRouter.Presentation.cs`, `dotnet/Foxwarm/MessageRouter.cs`

## Purpose

Normalizes Main-local message ingress, handles commands, resolves exact Session owners, and returns explicit route results without becoming a second persistence layer.

## Stable methods and callers

- `HandleMessageAsync` resolves presentation commands through catalog first, then obtains the exact `SessionOwner` through `SessionRuntime`.
- `/fork`, `/session clear`, `/continue`, `/compact`, `/dequeue`, `/stop`, and `/stop compact` map to typed runtime/manager operations and preserve partial/committed error fields.
- Ordinary text becomes `QueueItem.UserText`; parts are deep-cloned before `SubmitAndRunAsync` or owner-attached submission.
- Identity move and deletion commands delegate to `SessionManager` handlers; presentation commands use Main catalog/presentation boundaries.

## Contract and side effects

The router returns `202` for accepted ordinary input with a non-durable-completion note; queue persistence semantics remain in `SessionSaveLane.Wait`. It never edits active JSON, Archive, or catalog directly. Unsupported slash commands return explicit `422`; busy/history mutation conflicts preserve retryable statuses.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionTurnTests.cs`; `SessionPresentationTests.cs`; `SessionDeletionTests.cs`; `SessionIdentityMoveTests.cs`.
