# Unit: Session sequence projection and deliverySeq

Files: `dotnet/Foxwarm/Sessions/SessionManager.DeliverySeq.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.Links.cs`, `dotnet/Foxwarm/Sessions/SessionSequenceProjection.Parse.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveSequence.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveSequence.Paging.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Sequence.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Sequence.cs`, `dotnet/Foxwarm.DevTools/SequenceBenchCommand.cs`, `dotnet/Foxwarm.Tests/Sessions/DeliverySeqTests.cs`, `dotnet/Foxwarm.Tests/Sessions/SessionSequenceProjectionTests.cs`, `dotnet/Foxwarm.Tests/Sessions/SessionSequencePagingTests.cs`, `dotnet/Foxwarm.Tests/Channels/WebUiSequenceRouteTests.cs`
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
| `SessionCatalog.SequenceSessions` | Every catalog Session with the fields that reveal whether its cached Archive span changed (last-message time, busy, message count) |
| `SqliteArchiveSequence.Span` | Main-memory span cache: first own row (immutable) and last own row, re-read only when the catalog fields changed |
| `SqliteArchiveSequence.SeqBefore` / `Positions` / `ReadRange` | Highest own `seq` before a cursor by binary search, newest-first `(seq, timestamp)` chunks for the merge, and the selected rows with extracted JSON fields (plus the calling model row for a leading tool row) |
| `SqliteArchiveSequence.ReadAfter` | Live rows after a Session's cursor, or from `since` for a Session without one |
| `ArchiveSequenceCursor` | `(at, sessionId?, seq?)` paging position; a time-only cursor is a minute boundary |
| `SessionSequenceProjection.BuildPage` | k-way newest-first merge over candidate Sessions, minute-boundary page end (row cursor only for an oversized minute), normalization, pairing and visibility |
| `SessionSequenceProjection.BuildIncremental` | Live append for known cursors and newly active Sessions |
| `SessionSequenceProjection.Pair` | Exact, inferred, queued/unread, `pending: "older"` and child-creation links with stable keys |
| `ParseWrapper` / `WrapperTime` / `ParseDeliverySeq` | Leading trusted wrapper attributes, wrapper send time and ID anchors |
| `WebUIChannel.RegisterSequenceRoutes` / `OpaquePeer` | `POST /api/session-sequence` validation, scoped visibility and process-keyed opaque peer IDs |
| `TaskStore.Summaries` | Title/status of Tasks referenced by links, administrator view only |

## Route

`POST /api/session-sequence` takes either a page request, `before` (a cursor returned as `next`; omitted for the newest page) and `limit` (rows, default 400, max 2000), or a live request, `after` (Session ID to last `seq`) with `since` (ms) and `eventLimit` (rows per Session). `sessionIds` (up to 1000) restricts either to those Sessions. Responses carry `mode` (`page`/`incremental`), `sessions` (lane rows with display fields, `firstSeq`/`lastSeq`/`maxSeq`, `createdAt` (first own row), `startedAt`), `peers`, `events` (`llm` items with bounded assistant text and `phase`, `tool` items with tool name, argument preview, status/error, call position, `deliverySeq` and subcalls), `links` (`kind`, `key`, `from`/`to` endpoints with lane, `sessionId`, anchor `seq`/`call`/`sub`, `sentAt`, `consumedAt`, `pairing`, `state`, `pending`, Task reference), `cursors`, `tasks` (administrators) and `elapsedMs`; pages add `range`, `next` and `hasMore`. Invalid input, including `before` combined with `after`, returns `SESSION_SEQUENCE_INVALID`.

## Measurements

`Foxwarm.DevTools sequence-bench ROOT [ACTIVE] [ROWS] [DAYS] [IDLE]` builds a disposable synthetic root (inserting Archive rows directly) and times paging. The default shape is 100 active Sessions × 3,000 rows over 21 days plus 2,000 long-lived idle Sessions, each used once weeks ago and once recently (943 MiB Archive, 5% of tool outputs 100–200 KB). Release build, 2026-11-03:

| Request | Result |
|---|---|
| Newest page, 400 rows, cold span cache | 343 ms (53 lanes, 273 KiB) |
| Newest page, 2,000 rows, warm cache | 229 ms |
| Scrolling back all 21 days, 400-row pages | 764 pages, median 171 ms, p95 189 ms, max 262 ms |
| Scrolling back all 21 days, 2,000-row pages | 156 pages, median 258 ms, p95 294 ms, max 314 ms |
| Single page 1 / 7 / 20 days back | 157 / 177 / 128 ms |
| Live request, nothing new | 3 ms |

Page cost stays flat with depth and with the number of idle Sessions: the cached spans skip Sessions outside the scan position without Archive reads, and per-Session `seq` binary searches and position chunks are indexed. No index or derived store was added.

## Tests

- `DeliverySeqTests` runs real model batches: a parallel batch (`seq.1`, ToolScript `seq.2.1`/`seq.2.2`, child creation `seq.3`), a single direct send (`seq`), a single-call script (`seq.1.1`), a Task assignment notification, a timer-started script (`ts:runId.n`), run-wide `ts:` numbering across two unanchored slices of one run, and both receiver wrappers and sender evidence. `ClaudeRuntimeTests` checks the Claude Code anchor.
- `SessionSequenceProjectionTests` covers assistant text phases and authored input previews, exact pairing, queued deliveries, Task and spawn links, live `after` cursors, scoped visibility and legacy inferred pairing.
- `SessionSequencePagingTests` pages a fixture with a long-lived idle Session (rows three days apart), a turn whose rows follow its catalog input time by 30 minutes, an exact delivery read five minutes after sending and a 20-row minute: every row appears exactly once, pages are contiguous and end on minute boundaries (the oversized minute only splits at small limits), the split delivery keeps one key with the read half `pending: "older"`, and live requests return new rows for known cursors and newly active Sessions.
- `WebUiSequenceRouteTests` covers the authenticated route for administrator and scoped identities.
