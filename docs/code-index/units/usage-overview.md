# Unit: Installation usage overview

Files: `dotnet/Foxwarm/Sessions/UsageOverview.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Usage.cs`
Secondary files: `dotnet/Foxwarm/Models/LlmRequestJournal.Usage.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiRealtime.cs`

## Purpose

Answers how many model requests, tokens and recorded cost the installation used over a period, grouped by Agent, Session tree, Session, model, provider or request purpose. It reads the journal's [usage ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger), so it covers every request purpose and deleted Sessions; Session stats and catalog summaries keep their own per-Session normal-turn scope. It is read-only reporting: no budgets, limits or configuration ([D-webui-system-usage](./webui-system-view.md#d-webui-system-usage)).

## Stable methods and callers

- `SessionManager.Usage` is created with the shared journal store and is disposed before the journal.
- `StartBackfill` runs the journal's [ledger backfill](./model-journal.md) in the background on the Main host after Session owners are registered; a reported ledger write failure starts another pass. Cancellation at shutdown stops it between batches; the next start resumes from its checkpoints.
- `DescribeSessions` maps recorded Session IDs (exact or through a committed alias) to the current Session, its Agent and the timestamp of its first Archive row, or, for deleted Sessions, to the Agent recorded in their Archive. Unresolvable IDs stay unattributed. Archive facts are cached because Archive rows never change.
- Attribution happens at query time ([D-llm-request-journal-usage-ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger)): usage of a current Session belongs to that Session's current Agent, so it follows a moved Session. Rows recorded for a Session ID before the current Session's history began belong to an earlier, deleted Session with that ID and are reported as deleted.
- `QueryAsync(boundaries, groupBy, agent, limit)` returns the report used by System › Usage and the status bar Total.
- `Changed` fires after committed ledger rows, coalesced by `ChangeDelay` (one second); `WebUiRealtime` forwards it to administrator list subscribers as `usage-changed`.

## HTTP contract

`GET /api/usage?boundaries=<epoch ms,...>&groupBy=<grouping>&agent=<id>&limit=<n>` is administrator-only: it is not in the scoped identity route allowlist ([access identities](./dotnet-access-identities.md)).

- `boundaries`: 2 to 401 non-negative, strictly increasing millisecond values; consecutive pairs are half-open buckets. The browser supplies local-time day or hour edges, so the server has no time-zone setting.
- `groupBy`: optional `agent`, `tree`, `session`, `model`, `provider` or `purpose`. `agent`: optional exact Agent filter by current attribution (1–256 characters). `limit`: 1–500 groups, default 100.
- Unknown, duplicate or malformed parameters return 400 with `code: "USAGE_INVALID_QUERY"`.

The response has `version: 1`, the echoed `boundaries`, `groupBy` and `agent`, `total`, one entry per bucket in `buckets`, `coverage` and, when grouped, `groups` plus `groupCount`. Each usage object carries `requests`, `cachedTokens`, `inputTokens`, `outputTokens`, `unpricedRequests` and `cost`, which is present only when at least one counted request had a recorded cost. `coverage.earliest` is the first recorded request; `coverage.complete` is false while the backfill is still adding older results.

Group rows have `key`, `kind`, `usage`, optional `label` and `agent`, and per-bucket usage for the first eight rows (the chart series). Kinds: `agent`; `unknown` (a Session request whose Agent could not be resolved); `none` (requests outside any Session); `tree` / `session` for current Sessions, with the display name and Agent, where a tree row is keyed by the current root of the recorded Session — or, with an `agent` filter, by the highest ancestor reached through that Agent's own Sessions, so another Agent's coordinator never stands in for the selected Agent's work; `deleted`, keyed by the Agent from the Archive, pooling every deleted Session of that Agent; and `model`, `provider` or `purpose`. Rows are ordered by recorded cost, then tokens, then requests.

## Tests

`dotnet/Foxwarm.Tests/Sessions/UsageOverviewTests.cs` (real priced turns in parent, child and other-Agent Sessions; every grouping; limit and group count; deleted Sessions pooled under their Agent; Archive fallback; backfill coverage; a moved Session's live and backfilled usage following its current Agent; Agent drill-down limited to the Agent's own trees; a reused Session ID kept apart from the earlier Session); `dotnet/Foxwarm.Tests/Models/LlmUsageLedgerTests.cs` (live rows, buckets, backfill order and resume, downgrade catch-up, restart without rescans, rebuilding a removed or emptied ledger without failing results, reads that do not wait for the writer); `dotnet/Foxwarm.Tests/Channels/UsageHttpTests.cs` (administrator access, scoped denial, invalid queries); `packages/webui/test/mainHostSystemUsage.e2e.mjs` (System › Usage and the status bar Total over a real Main host).
