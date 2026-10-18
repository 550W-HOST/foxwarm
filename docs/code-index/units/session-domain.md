# Unit: Session values, messages, Agent catalog/memory, waits, and presentation

Files: `dotnet/Foxwarm/Sessions/AgentCatalog.Bootstrap.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Identity.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.Metadata.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.Manifest.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.Selected.cs`, `dotnet/Foxwarm/Sessions/AgentMemory.cs`, `dotnet/Foxwarm/Sessions/Message/CanonicalMessage.cs`, `dotnet/Foxwarm/Sessions/Message/SessionHistory.cs`, `dotnet/Foxwarm/Sessions/Message/FunctionCallArguments.cs`, `dotnet/Foxwarm/Sessions/ModelRetryNotice.cs`, `dotnet/Foxwarm/Sessions/SessionNotices.cs`, `dotnet/Foxwarm/Sessions/SessionBlockCounter.cs`, `dotnet/Foxwarm/Sessions/SessionBoundary.cs`, `dotnet/Foxwarm/Sessions/SessionContinuation.cs`, `dotnet/Foxwarm/Sessions/SessionGoal.cs`, `dotnet/Foxwarm/Sessions/SessionIdentity.cs`, `dotnet/Foxwarm/Sessions/SessionListQueries.Summaries.cs`, `dotnet/Foxwarm/Sessions/SessionListQueries.cs`, `dotnet/Foxwarm/Sessions/SessionObservation.cs`, `dotnet/Foxwarm/Sessions/SessionPresentation.cs`, `dotnet/Foxwarm/Sessions/SessionWait.cs`, `dotnet/Foxwarm/Sessions/SessionWaitTimeouts.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.Cased.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.Ignorable.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.Mappings.cs`, `dotnet/Foxwarm/Sessions/SourceStringLower.cs`, `dotnet/Foxwarm/Sessions/WaitLiveness.cs`

## Purpose

Defines stable Session/Agent identity and message shapes used by owner/runtime, JSON authority, catalog authority, model request construction, tools, and WebUI.

## Stable symbols and callers

- `SessionIdentity` is the canonical `(sessionId, agent)` lifetime key; `SessionBoundary`/`SessionContinuation` carry fork/continuation relationships.
- `CanonicalMessage`, `FunctionCallArguments`, and `ModelRetryNotice` define validated history/tool/retry records; `SessionObservation.cs` supplies message-page and targeted status observation helpers plus the `session` parent-update dispatch. Targeted status resolves aliases to the real hot owner, accounts for that owner's persistent memory snapshot, and does not admit unknown IDs.
- `SessionBoundary.ChannelInput` creates the existing WebUI source wrapper at ingress, with source time and hint. Plain text uses one wrapper; structured input retains its parts between opening/closing parts. Deferred consumption decorates that source wrapper rather than manufacturing one later.
- `SessionNotices.Create` constructs version-1 bounded typed operational metadata and preserves original diagnostics in display-only model parts. `SessionOwner.PresentFailureAsync` deduplicates exact errors per owner, recognizes existing terminal retry tails, appends safely through the canonical save lane or publishes a temporary message when authority is unsafe. Existing visibility filtering excludes both forms from provider replay.
- `SessionWait`, `SessionWaitTimeouts`, and `WaitLiveness` distinguish declared durable waits from transient in-flight states.
- `AgentCatalog`/`AgentMemory` load Agent metadata, selected/conditional memory, manifests, and knowledge references; `SessionListQueries` builds query DTOs but does not own catalog rows.
- `SessionPresentation`, `SessionGoal`, counters, and source normalization provide stable fields for manager/save-lane/UI operations.

## Contract and side effects

These are value/domain boundaries, not persistence writers. JSON authority owns active history/queue/wait semantic instances; catalog owns Main identity/topology/presentation summaries. Agent memory selection can affect a prompt but does not mutate Session history until a turn save commits its canonical result.

## History ownership

`HistoryMessage` owns an immutable `JsonElement`: mutable JSON is serialized at admission, and externally supplied elements are cloned out of their document lifetime. Its `Data`, scalar properties, and history indexing/enumeration are read-only; `ToJson` and `SessionHistory.Materialize` explicitly create detached mutable projections. `SessionHistory` wraps a persistent immutable list. Snapshot capture shares its root, append path-copies the list with newly owned records, and retry replaces only its changed record. `SessionHistoryBuffer` changes the owner's root under the existing state gate. Registry restore and fork can share roots without sharing mutable JSON.

Compaction builds a new root while retaining unchanged immutable records; preserved-record metadata and pruned responses produce replacement records. Clear installs the empty root. Old snapshots retain their prior roots across these operations and across queue, Stop, task, and settings changes. Queue and envelope snapshots still use meaningful isolation copies. The ordinary chat path carries the captured root to its request projection so the [journal can reuse immutable record preparation](./model-journal.md#immutable-record-preparation), without looking up provenance in fresh live state. Mutable request repair, authority/Archive publication, and tool/UI JSON output use explicit projections; durable formats and Archive ownership do not change.

`CanonicalMessage` owns one private JSON tree; its part views borrow children of that tree and expose only detached JSON values. Validation/visibility inspection does not require creating a canonical copy. This is distinct from history structural sharing: caller-owned request JSON still needs an ownership boundary.

## Tests

`dotnet/Foxwarm.Tests/Sessions/*` (including `SessionHistoryOwnershipTests.cs`); `dotnet/Foxwarm.Tests/Memory/MessageJsonTests.cs`; `ConditionalMemoryTests.cs`; presentation/list/identity tests.
