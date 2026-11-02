# Unit: Session sequence projection and deliverySeq

Files: `dotnet/Foxwarm/Sessions/SessionManager.DeliverySeq.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.Links.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.Parse.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveSequence.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Sequence.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Sequence.cs`, `dotnet/Foxwarm.DevTools/SequenceBenchCommand.cs`, `dotnet/Foxwarm.Tests/Sessions/DeliverySeqTests.cs`, `dotnet/Foxwarm.Tests/Sessions/SessionSequenceProjectionTests.cs`, `dotnet/Foxwarm.Tests/Channels/WebUiSequenceRouteTests.cs`
Secondary files: `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.ToolScript.cs`, `dotnet/Foxwarm/ToolScript/MainToolScript.HostCalls.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptContext.cs`, `dotnet/Foxwarm/Sessions/TaskStore.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiAccess.cs`, `dotnet/Foxwarm.Tests/Sessions/ClaudeRuntimeTests.Tools.cs`

## Purpose

Implements [D-session-delivery-seq](../threads/session-sequence-view.md#d-session-delivery-seq) and the read-only projection behind [D-session-sequence-projection](../threads/session-sequence-view.md#d-session-sequence-projection).

## Function index

| Symbol | Responsibility |
|---|---|
| `SessionManager.BatchDeliverySeq` / `SubCallDeliverySeq` | Format `seq`, `seq.k`, `seq.k.n` and `ts:runId.n` IDs from positions |
| `SessionManager.SetDeliverySeq` / `DeliverySeqFor` | Per-call `AsyncLocal` scope; `SendAsync` reads it only for the same source Session |
| `TurnToolInvocation.AnchorSeq` / `DeliverySeq` | Batch call anchor from `BeginBatch`; ToolScript subcalls inherit the computed ID via `scriptDelivery` |
| `ToolScriptContext.SubCallOrdinal` / `RunSubCallOrdinal` | 1-based subcall position within the slice (matching `subCalls`) and across the run (persisted `subCallTotal`, used for `ts:` IDs) |
| `SessionCatalog.SequenceCandidates` | Recent-or-busy catalog rows through the existing recent-rank and busy indexes |
| `SqliteArchiveSequence.Read` | Read-only Archive connection, window start by binary search on `seq`, newest/after-cursor bounded rows, extracted JSON fields only, and the calling model row for a leading tool row |
| `SessionSequenceProjection.Build` | Lane selection, focus component, normalization, pairing, Session/peer projection and visibility |
| `SessionSequenceProjection.Pair` | Exact, inferred, queued/unread and child-creation links with stable keys |
| `ParseWrapper` / `WrapperTime` / `ParseDeliverySeq` | Leading trusted wrapper attributes, wrapper send time and ID anchors |
| `WebUIChannel.RegisterSequenceRoutes` / `OpaquePeer` | `POST /api/session-sequence` validation, scoped visibility and process-keyed opaque peer IDs |
| `TaskStore.Summaries` | Title/status of Tasks referenced by links, administrator view only |

## Route

`POST /api/session-sequence` accepts `since` (ms, required), optional `focusSessionId`, `sessionIds`, `after` (Session ID to last `seq`), `sessionLimit` and `eventLimit`. It returns `sessions` (lane rows with display fields, `firstSeq`/`lastSeq`/`maxSeq`, `truncated`, `startedAt`), `peers`, `events` (`llm`/`tool` intervals with tool name, status, call position, `deliverySeq`, subcalls and bounded previews), `links` (`kind`, `key`, `from`/`to` endpoints with lane, `sessionId`, anchor `seq`/`call`/`sub`, `sentAt`, `consumedAt`, `pairing`, `state`, Task reference), `cursors`, `tasks` (administrators), `truncatedSessions` and `elapsedMs`. Invalid input returns `SESSION_SEQUENCE_INVALID`.

## Measurements

`Foxwarm.DevTools sequence-bench ROOT [SESSIONS] [ROWS] [DAYS]` builds a disposable synthetic root (inserting Archive rows directly) and times the projection. With 100 Sessions × 3,000 rows over 7 days (2.2 GiB Archive, 5% of tool outputs 100–200 KB), median timings were: 1 h window 124 ms (30 lanes/400 rows) and 317 ms (80/2,000); 6 h 341 ms and 1.2 s; 24 h 740 ms and 3.7 s. Cost scales with rows returned, not Archive size: the window search and row reads are indexed; most time is SQLite JSON extraction and response construction. The default limits keep ordinary windows well below a second, so no index or derived store was added.

## Tests

- `DeliverySeqTests` runs real model batches: a parallel batch (`seq.1`, ToolScript `seq.2.1`/`seq.2.2`, child creation `seq.3`), a single direct send (`seq`), a single-call script (`seq.1.1`), a Task assignment notification, a timer-started script (`ts:runId.n`), run-wide `ts:` numbering across two unanchored slices of one run, and both receiver wrappers and sender evidence. `ClaudeRuntimeTests` checks the Claude Code anchor.
- `SessionSequenceProjectionTests` covers exact pairing, queued deliveries, Task and spawn links, focus components, window and row bounds, `after` cursors, scoped visibility and legacy inferred pairing.
- `WebUiSequenceRouteTests` covers the authenticated route for administrator and scoped identities.
