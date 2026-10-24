# Unit: Message routing and presentation commands

Files: `dotnet/Foxwarm/MessageRouter.Controls.cs`, `dotnet/Foxwarm/MessageRouter.Deletion.cs`, `dotnet/Foxwarm/MessageRouter.IdentityMove.cs`, `dotnet/Foxwarm/MessageRouter.Presentation.cs`, `dotnet/Foxwarm/MessageRouter.cs`

## Purpose

Normalizes Main-local and external-channel message ingress, handles commands, resolves exact Session owners, and returns explicit route results without becoming a second persistence layer.

## Stable methods and callers

- `HandleMessageAsync` resolves presentation commands through catalog first, then obtains the exact `SessionOwner` through `SessionRuntime`.
- [Public command administration](./dotnet-command-administration.md) shares text commands across actual WebUI and external callers without replacing their authorization gates. `/fork`, `/session clear`, `/continue`, `/compact`, `/dequeue`, `/stop`, and `/stop compact` map to typed runtime/manager operations and preserve partial/committed error fields.
- `HandleControlAsync` recognizes correlated WebUI controls, maps actual admission/no-op/error outcomes into bounded Session events, and publishes fresh state. `ControlAction` also recognizes unsupported arguments for those command families so they receive honest errors. Manual compact accepts the supported keep-percentage argument; the unimplemented tool-pruning variant is rejected. Continue and cancellation completion are observed independently after acceptance; no command row is appended.
- Ordinary channel input receives its source-time/hint wrapper through `SessionBoundary.ChannelInput` before `SubmitAndRunAsync` or owner-attached submission. Plain text uses one system part, preserving body whitespace and joining text chunks with newlines; structured parts are deep-cloned between opening/closing wrapper parts. Client identity is retained. Deferred queue consumption decorates this existing wrapper rather than creating a source wrapper while reconstructing a request.
- Identity move and deletion commands delegate to `SessionManager` handlers; presentation commands use Main catalog/presentation boundaries.

## Contract and side effects

The router returns `202` for accepted ordinary input with a non-durable-completion note; queue persistence semantics remain in `SessionSaveLane.Wait`. It never edits active JSON, Archive, or catalog directly. Unsupported slash commands return explicit `422`; busy/history mutation conflicts preserve retryable statuses.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionTurnTests.cs`; `SessionPresentationTests.cs`; `SessionDeletionTests.cs`; `SessionIdentityMoveTests.cs`; `DeferredInputTests.cs`; `dotnet/Foxwarm.Tests/scripts/qualify-attempt-input.mjs` (actual HTTP ingress and delayed input).

Scoped browser calls reach the ordinary message router only after text/command/upload validation. Their optional final live assertion passes through the exact owner and existing ingress/save lane immediately before hot admission. Administrator selected-Session commands and correlated controls retain their existing authority; see [shared access](./dotnet-access-identities.md).

External-channel discovery, authorization, guest creation, shared commands and attachment resolution are mapped in [external channels](./dotnet-external-channels.md). Telegram retains its distinct pre-Router command hook; ordinary external content reaches the existing User queue lane with external source metadata, not inter-Session authority.
