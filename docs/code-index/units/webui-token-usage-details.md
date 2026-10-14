# Unit: webui-token-usage-details

Files: packages/webui/src/components/TokenUsageDetails.tsx
Secondary files: packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/test/workbenchPreview.e2e.mjs

## Purpose

Shared presentation of cumulative token usage for Architecture and status-bar popovers. Data acquisition and scope remain owned by the calling bounded controllers; this renderer neither fetches nor aggregates Session data.

## Key exports

- `TokenUsage` — cached, uncached input, and output counters.
- `formatUsageNumber` — compact, one-decimal English numeric formatting.
- `TokenUsageDetails` — total, semantic proportional bar, and optional detailed rows with percentages.

## Behavior

- Total is cached + uncached input + output; no reasoning-subset value is added separately.
- Cached/Input/Output have shared semantic colors and icons. Detailed percentages use the cumulative total and handle a zero denominator.
- `loaded` labels an explicitly loaded-window aggregate; ordinary global or single-Session counters use Tokens. Missing data displays an unavailable value rather than an invented zero.
- These lifetime counters are separate from one logical request's context occupancy or current compaction budget.
- Accessible bar text and title include exact counts while the visible numbers stay compact.
