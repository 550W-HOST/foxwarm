# Unit: Message routing and presentation commands

Files: `dotnet/Foxwarm/MessageRouter.Controls.cs`, `dotnet/Foxwarm/MessageRouter.Deletion.cs`, `dotnet/Foxwarm/MessageRouter.IdentityMove.cs`, `dotnet/Foxwarm/MessageRouter.Presentation.cs`, `dotnet/Foxwarm/MessageRouter.cs`

## Purpose

Normalizes Main-local message ingress, handles commands, resolves exact Session owners, and returns explicit route results without becoming a second persistence layer.

## Stable methods and callers

- `HandleMessageAsync` resolves presentation commands through catalog first, then obtains the exact `SessionOwner` through `SessionRuntime`.
- `/fork`, `/session clear`, `/continue`, `/compact`, `/dequeue`, `/stop`, and `/stop compact` map to typed runtime/manager operations and preserve partial/committed error fields.
- `HandleControlAsync` recognizes correlated WebUI controls, maps actual admission/no-op/error outcomes into bounded Session events, and publishes fresh state. `ControlAction` also recognizes unsupported arguments for those command families so they receive honest errors. Continue and cancellation completion are observed independently after acceptance; no command row is appended.
- Ordinary channel input receives its source-time/hint wrapper through `SessionBoundary.ChannelInput` before `SubmitAndRunAsync` or owner-attached submission. Plain text uses one system part, preserving body whitespace and joining text chunks with newlines; structured parts are deep-cloned between opening/closing wrapper parts. Client identity is retained. Deferred queue consumption decorates this existing wrapper rather than creating a source wrapper while reconstructing a request.
- Identity move and deletion commands delegate to `SessionManager` handlers; presentation commands use Main catalog/presentation boundaries.

## Contract and side effects

The router returns `202` for accepted ordinary input with a non-durable-completion note; queue persistence semantics remain in `SessionSaveLane.Wait`. It never edits active JSON, Archive, or catalog directly. Unsupported slash commands return explicit `422`; busy/history mutation conflicts preserve retryable statuses.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionTurnTests.cs`; `SessionPresentationTests.cs`; `SessionDeletionTests.cs`; `SessionIdentityMoveTests.cs`; `DeferredInputTests.cs`; `dotnet/scripts/qualify-attempt-input.mjs` (actual HTTP ingress and delayed input).
