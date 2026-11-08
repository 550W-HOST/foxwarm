# Unit: webui-token-usage-details

Files: packages/webui/src/components/TokenUsageDetails.tsx, packages/webui/src/usageCost.ts, packages/webui/test/usageCost.e2e.mjs
Secondary files: packages/webui/src/components/SystemShared.tsx, packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/src/useUsageReport.ts, packages/webui/test/workbenchPreview.e2e.mjs

## Purpose

Shared presentation of cumulative token usage for System and status-bar popovers. Data acquisition and scope remain owned by the callers; this renderer neither fetches nor aggregates usage.

## Key exports

- `TokenUsage` — cached, uncached input, output counters and optional saved USD `cost`.
- `formatUsdCost` — readable saved USD estimates, preserving zero and showing tiny positive values below display precision.
- `formatUsageNumber` — compact, one-decimal English numeric formatting.
- `TokenUsageDetails` — total, semantic proportional bar, and optional detailed rows with percentages.

## Behavior

- Total is cached + uncached input + output; no reasoning-subset value is added separately.
- Cached/Input/Output have shared semantic colors and icons. Detailed percentages use the cumulative total and handle a zero denominator.
- `loaded` labels an explicitly loaded-window aggregate; ordinary global or single-Session counters use Tokens. Missing data displays an unavailable value rather than an invented zero.
- These lifetime counters are separate from one logical request's context occupancy or current compaction budget.
- Accessible bar text and title include exact counts while the visible numbers stay compact.

Optional cost displays as a recorded estimate separately from token totals, percentages and bars. Loaded-window aggregation includes only present costs; global and single-Session callers pass their existing scopes. Unknown costs do not become zero. The accounting contract is [D-model-usage-cost](../threads/model-request-and-streaming.md#d-model-usage-cost).

## Status bar Total

The status bar Total is the installation-wide [usage ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger) total for a selectable period, Today (default) or This month, read from `GET /api/usage` with one local-time bucket and refreshed on the realtime `usage-changed` event and at local midnight. It counts every recorded request purpose and deleted Sessions, so it differs from the sum of Session pies, which stay per-Session normal-turn stats. The choice persists in `localStorage`. Its popover shows the period switch, the token breakdown with recorded cost, the request count and how many requests have no price, and opens System › Usage on the same period ([D-webui-system-usage](./webui-system-view.md#d-webui-system-usage)).
