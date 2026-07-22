# Unit: webui-architecture-view

Files: packages/webui/src/components/ArchitectureView.tsx

## Purpose

Renders a hierarchical architecture view of agent sessions, displaying them as an expandable tree with summary statistics, agent filtering, and real-time busy-duration tracking. It visualizes parent-child session relationships with metadata badges, token usage, and navigation controls.

## Key Exports

- `ArchitectureView` — Main React component (default/named export) that renders the full architecture dashboard
- `ArchitectureViewProps` — Props interface for the component

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `sortSessions(a, b)` | ~16–30 | Sorts sessions by busy state, queue length, child count, then recency |
| `formatRelativeTime(timestamp)` | ~31–42 | Converts timestamp to human-readable relative time string |
| `formatBusyDuration(busyStartedAt, now)` | ~44–54 | Formats elapsed busy time as h/m/s string |
| `formatTokenMillions(value)` | ~56–63 | Formats token counts as abbreviated millions (e.g. "1.23m") |
| `renderMetaBadge(label, tone)` | ~65–78 | Returns a styled badge span element with tone-based coloring |
| `SessionNode({...})` | ~96–190 | Recursive tree node component rendering a session card with children |
| `ArchitectureView({...})` | ~192–end | Main component: builds session tree, computes summary stats, renders UI |

## Dependencies

- `Session` type from `./SessionListCore` — defines the session data shape used throughout

## Behavior

- Builds a `sessionMap` and `childrenMap` from the flat sessions array to construct a parent-child tree structure
- Computes aggregate summary stats (total sessions, busy count, total tokens by type, active agents)
- Computes active/busy summary stats from canonical runtime state (`requesting-model` / `running-tool`) with legacy `busy` fallback, and displays richer status text such as `tool: exec` or `waiting: sessions 1/2` when available.
- Maintains local state for: expanded nodes (`expandedSessions`), "show more" children toggles, selected agent filter, and a `now` timestamp that ticks every second for live busy-duration updates
- Filters root sessions by selected agent (including their descendants)
- `SessionNode` recursively renders children with configurable preview counts (10 for root, 8 for nested) and a "show more" toggle
- Uses `useEffect` with a 1-second interval to keep busy durations updating in real time
- The 1-second timer runs while any session is active according to runtime state, so active durations update for model requests and tool execution without treating `waiting` as busy.

## Integration

- Receives session data and callbacks from a parent component via props (`sessions`, `onSelectSession`, `onBack`)
- The Code `foxwarmEmbed=agents` leaf lazily reuses this component inside a stable Agents custom editor, owns the global session list/stream needed by the dashboard, and bridges session selection to deterministic chat editors.
- `onSelectSession` navigates to a specific session's detail/chat view
- `onBack` triggers navigation back to a previous view (rendered as a back button in the header)
- Depends on the `Session` interface from `SessionListCore`, indicating it's part of a multi-view session management UI