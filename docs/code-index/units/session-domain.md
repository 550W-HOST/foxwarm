# Unit: Session values, messages, Agent catalog/memory, waits, and presentation

Files: `dotnet/Foxwarm/Sessions/AgentCatalog.Bootstrap.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Identity.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Metadata.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.Manifest.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.Selected.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.cs`, `dotnet/Foxwarm/Sessions/Message/CanonicalMessage.cs`, `dotnet/Foxwarm/Sessions/Message/FunctionCallArguments.cs`, `dotnet/Foxwarm/Sessions/ModelRetryNotice.cs`, `dotnet/Foxwarm/Sessions/SessionBlockCounter.cs`, `dotnet/Foxwarm/Sessions/SessionBoundary.cs`, `dotnet/Foxwarm/Sessions/SessionContinuation.cs`, `dotnet/Foxwarm/Sessions/SessionGoal.cs`, `dotnet/Foxwarm/Sessions/SessionIdentity.cs`, `dotnet/Foxwarm/Sessions/SessionListQueries.Summaries.cs`, `dotnet/Foxwarm/Sessions/SessionListQueries.cs`, `dotnet/Foxwarm/Sessions/SessionObservation.cs`, `dotnet/Foxwarm/Sessions/SessionPresentation.cs`, `dotnet/Foxwarm/Sessions/SessionWait.cs`, `dotnet/Foxwarm/Sessions/SessionWaitTimeouts.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.Cased.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.Ignorable.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.Mappings.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.cs`, `dotnet/Foxwarm/Sessions/WaitLiveness.cs`

## Purpose

Defines stable Session/Agent identity and message shapes used by owner/runtime, JSON authority, catalog authority, model request construction, tools, and WebUI.

## Stable symbols and callers

- `SessionIdentity` is the canonical `(sessionId, agent)` lifetime key; `SessionBoundary`/`SessionContinuation` carry fork/continuation relationships.
- `CanonicalMessage`, `FunctionCallArguments`, and `ModelRetryNotice` define validated history/tool/retry records; `SessionObservation.cs` supplies message-page and targeted status observation helpers plus the `session` parent-update dispatch. Targeted status resolves aliases to the real hot owner, accounts for that owner's persistent memory snapshot, and does not admit unknown IDs.
- `SessionWait`, `SessionWaitTimeouts`, and `WaitLiveness` distinguish declared durable waits from transient in-flight states.
- `AgentCatalog`/`AgentMemory` load Agent metadata, selected/conditional memory, manifests, and knowledge references; `SessionListQueries` builds query DTOs but does not own catalog rows.
- `SessionPresentation`, `SessionGoal`, counters, and source normalization provide stable fields for manager/save-lane/UI operations.

## Contract and side effects

These are value/domain boundaries, not persistence writers. JSON authority owns active history/queue/wait semantic instances; catalog owns Main identity/topology/presentation summaries. Agent memory selection can affect a prompt but does not mutate Session history until a turn save commits its canonical result.

## Tests

`dotnet/Foxwarm.Tests/Sessions/*`; `dotnet/Foxwarm.Tests/Memory/MessageJsonTests.cs`; `ConditionalMemoryTests.cs`; presentation/list/identity tests.
