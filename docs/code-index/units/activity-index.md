# Unit: Installation activity index

Files: `dotnet/Foxwarm/Sessions/ActivityIndex.cs`, `dotnet/Foxwarm/Sessions/Storage/ArchiveToolEffects.cs`, `dotnet/Foxwarm/Sessions/ActivityKinds.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Activity.cs`
Secondary files: `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveMessageStore.cs`, `dotnet/Foxwarm/Sessions/Storage/SqliteArchiveIdentityMove.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.ToolScript.cs`, `dotnet/Foxwarm/McpInboundCatalog.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Activity.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiRealtime.cs`

## Purpose

Answers who ran which tool, on which Node, with which effect, across the installation, for the administrator-only [System › Activity](./webui-system-view.md) section ([D-activity-index](#d-activity-index)). It reads the per-call records each tool row already carries ([D-tool-effect-record](../threads/tools-permissions-and-exec.md#d-tool-effect-record)): it adds no tool behavior, policy or model-facing surface, and nothing reads it to reconstruct Sessions.

## Contracts

- **The Archive row is the authority.** `archive_tool_effects` in `state/archive-store.sqlite` holds one derived row per direct call (`sub = 0`) and per ToolScript subcall of each Archive `tool` row, keyed by `(session_id, seq, part, sub)`. Every column can be rebuilt from Archive rows, so the table may be dropped at any time. `archive_messages` keeps its exact schema; the activity tables are separate, like `archive_blocks` and `archive_checkpoints`.
- **Never fails or reorders an Archive write.** `SqliteArchiveMessageStore` indexes the tool rows of each committed write inside the same transaction under the savepoint `archive_tool_effects_live`. Any index failure (for example a dropped table) rolls back only the index rows; the Archive rows commit and `ToolEffectsFailed` starts a repair pass. Exact compensation (`RollbackInsertedMessages`) deletes the matching index rows in its own transaction.
- **Direct records** (`archive_direct_effects`) hold effects that never reach a Session Archive: calls made by unattended ToolScript slices (timer or webhook runs, origin `timer-script` / `webhook-script`) and inbound MCP `foxwarm_call` calls (origin `external-mcp`, with the external principal). They are the only record of those effects, are not derived and are kept across rebuilds. Writing one is queued behind earlier direct records, never awaited by the call, and a failure is logged without changing the call's result. Argument previews are masked with the instance secrets before they are stored.
- **Retention follows the Archive**: nothing is pruned separately. Identity moves rename `session_id` in both tables with the other Archive tables.
- Only physical rows are indexed. A forked Session's inherited prefix stays with its source Session; activity is never duplicated per fork.

## Row contents

Each row records the Agent that owned the Session when it was written (`agent`), the start time and duration from `executionTiming` (falling back to the row timestamp), origin, the canonical tool (`target` name/source/server/node, or for older rows the `call_tool` wrapper's tool ID and the exec record's Node), the `action` argument when present, outcome, error type, approval status and decider, the deciding rules, a bounded argument summary (`SessionToolExecutor.ToolArgsPreview`, at most 200 characters), the model row that issued the call (`anchor_seq`), the initiator of the turn, the ToolScript run ID for direct script records, and bounded references (resolved paths, exec ID and cwd, delivery targets).

- **Outcome**: `ok`, `error`, `denied` (`tool_authorization_denied`, or a subcall whose recorded rules include a deny), `approval-rejected`, `approval-expired` (expired or unavailable), `cancelled`, `skipped`.
- **Initiator** is read from the nearest earlier input row of the same Session, at most 200 rows back: a recorded WebUI sender (`administrator` or `identity`), a trusted Foxwarm wrapper (`channel`, `session` for inter-agent/ToolScript/task deliveries, `timer`, `webhook`, `user` for console/unwrapped input) or, when only background notices precede the call, `event`. Initiators are never guessed from text.
- Older rows without a recorded target still index tool name, outcome, timing and summary; their Node is unknown unless an exec record or resolved path names it.

## Backfill

`ActivityIndex.StartBackfill` runs after Session owners are registered, beside the [usage ledger](./usage-overview.md) backfill. `PrepareAsync` (small writer command) creates missing tables, and resets the checkpoints when the index was removed, emptied while its checkpoints claim coverage, or written by a different shape `Version` (which drops and rebuilds the derived table). Checkpoints `low` / `high` in `archive_effects_metadata` cover `archive_messages` row IDs: rows above `high` oldest first, then rows below `low` newest first, in batches of 500 Archive rows read and prepared on a read-only connection; the writer only inserts prepared rows with the checkpoint. Live writes extend `high` while everything before them is covered, so restarts do not rescan. Passes are idempotent and resume from checkpoints after cancellation.

Measured with the opt-in benchmark on an 8-CPU Linux machine (300,000 tool rows, 1.1 GiB Archive): adding the schema at first start takes under 0.3 s; the backfill indexes about 6,900 tool rows per second; minimal Archive writes during it waited p50 4 ms, p99 70 ms, max under 0.8 s.

## Queries

`ActivityIndex.Query(ActivityQuery)` returns one newest-first page from both tables, merged by `(started_at, key)` with a stable cursor (`beforeTime`, `beforeKey`). Filters: time range, Session scope (one Session, its tree, or the Sessions currently owned by an Agent), execution-time Agent, Node, tool, kind, outcome (or `problems` for anything but `ok`), initiator kind, origin and text in the summary or tool name. A Session scope reads through the primary key when its rows are few relative to the page and through the time index otherwise; reads use their own read-only connection and never wait for the writer. Each page item adds the current Session ID, current Agent, deleted flag and title through `UsageOverview.DescribeSessions`, and the response carries `coverage { complete, earliest }`.

`ActivityKinds` classifies canonical tool identities at read time (the same table in code and as a SQL expression): `exec`, `files`, `communicate`, `sessions`, `tasks`, `nodes`, `config`, `timers`, `browser`, `mcp`, `script`, `read`, `internal` and `other`. The default `changes` view excludes `read`, `internal` and `script` containers (each script call has its own row). MCP annotations are never consulted.

## HTTP contract

`POST /api/activity` with a JSON filter object is administrator-only: it is not in the scoped identity route allowlist ([access identities](./dotnet-access-identities.md)). Fields: `from`, `to`, `beforeTime` + `beforeKey`, `limit` (1–200, default 100), `sessionId` with optional `tree`, `agent` (current owner), `executionAgent`, `node`, `tool`, `kind` (`changes` default, `all`, or a kind), `outcome`, `initiator`, `origin` and `text`. Unknown or malformed fields return 400 with `code: "ACTIVITY_INVALID_QUERY"`. The response is `{ items, hasMore, next, coverage }`. `ActivityIndex.Changed` fires after committed index rows, coalesced to about once a second; `WebUiRealtime` forwards it to administrator list subscribers as `activity-changed`.

## Design Decisions

### D-activity-index

[2026-11-09, user decision] Audit uses a derived index of the records already in the Archive rather than a separate audit log or model-visible tool. Every call is indexed and the view defaults to changes. Coverage includes Session tool calls, unattended ToolScript/webhook runs and inbound MCP; human console actions are a later addition. The WebUI sender is recorded for administrators only. Version 1 is administrator-only with no model access. Both the execution-time and current Agent are shown. There is no cost, alerting or compliance feature. Rule IDs are recorded. Retention follows the Archive.

## Tests

`dotnet/Foxwarm.Tests/Sessions/ActivityIndexTests.cs` (live indexing of real turns with target, Node, rules, denial and ToolScript subcalls; the changes default, kinds, outcomes, text and paging; rebuilding a dropped, emptied or older-version index while later Archive writes commit; resumable backfill; compensation; unattended script records surviving rebuilds; initiator classification; SQL/code kind parity). `dotnet/Foxwarm.Tests/Channels/WebUiSenderTests.cs` (administrator-only route and filter validation). `dotnet/Foxwarm.Tests/Sessions/ActivityIndexBenchmark.cs` is an opt-in measurement (`FOXWARM_ACTIVITY_BENCH=<tool rows>`). `packages/webui/test/mainHostSystemActivity.e2e.mjs` covers the section over a real Main host; `packages/webui/test/activity.test.mjs` covers the client request and labels.
