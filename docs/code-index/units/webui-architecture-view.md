# Unit: webui-architecture-view

Files: packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/architecturePresentation.ts
Secondary files: packages/webui/test/sessionListAndWorkbenchState.test.mjs

## Purpose

Renders a bounded hierarchical architecture view with global catalog summary statistics, paged real-forest rows, agent filtering, exact watched-row deltas, and real-time busy-duration tracking.

## Key Exports

- `ArchitectureView` — Main React component (default/named export) that renders the full architecture dashboard
- `ArchitectureViewProps` — Props interface for the component
- `getArchitectureFocusReveal(...)` — Produces one canonical focus-path identity plus the strict ancestors required to reveal the current row without opening its descendants

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `formatRelativeTime(timestamp)` | ~31–42 | Converts timestamp to human-readable relative time string |
| `formatBusyDuration(busyStartedAt, now)` | ~44–54 | Formats elapsed busy time as h/m/s string |
| `formatTokenMillions(value)` | ~56–63 | Formats token counts as abbreviated millions (e.g. "1.23m") |
| `renderMetaBadge(label, tone)` | ~65–78 | Returns a styled badge span element with tone-based coloring |
| `SessionNode({...})` | ~96–190 | Recursive tree node component rendering a session card with children |
| `ArchitectureView({...})` | component | Fetches global summary/agent counts and paged forest windows, then renders them in server order |
| `loadArchitecture(append)` | component closure | Loads or extends the current global/agent-scoped Architecture root and initial-child window |
| `loadArchitectureChildren(sessionId)` | component closure | Continues one real-parent branch through the fixed child query API |

## Dependencies

- `Session` type from `./SessionListCore` — defines the session data shape used throughout

## Behavior

- Owns `/session-list/architecture` and `/session-list/children` calls; no complete Session-array prop or legacy global-list fetch is accepted.
- Displays global aggregate totals and agent counts from maintained catalog summaries even while one agent forest is selected.
- Keeps only loaded root/child windows and preserves backend order, including SQLite-BINARY tie order.
- Reuses the bounded atomic cursor replay and per-row HTTP/SSE epoch mechanism. Root depth can span multiple 100-row pages; every explicitly expanded branch is replayed in 20-parent/20-row batches, and reset or a shared presentation-revision mismatch restarts before publication.
- Computes active/busy summary stats from canonical runtime state (`requesting-model` / `running-tool`) with legacy `busy` fallback, and displays richer status text such as `tool: exec` or `waiting: sessions 1/2` when available.
- Maintains local state for: expanded nodes (`expandedSessions`), "show more" children toggles, selected agent filter, and a `now` timestamp that ticks every second for live busy-duration updates
- Current-session focus disclosure is navigation/path-change driven rather than refresh driven. One canonical focus-path identity expands only strict ancestors once; ordinary bounded replay and realtime row refresh preserve later manual collapse intent, including collapse of the current row itself.
- Collapsing an Architecture branch removes the row and its currently loaded descendants from local expansion state, so reopening the parent does not silently restore a previously hidden nested subtree.
- Agent selection asks the backend for the canonical same-agent forest; it does not infer a complete forest from partial browser rows.
- Architecture branch totals come only from its real-forest root/child queries. Exact focus rows may also carry Sidebar presentation counts for shared DTO compatibility, but Architecture does not use those counts to redefine pinned or cross-agent edges.
- `SessionNode` recursively renders children with configurable preview counts (10 for root, 8 for nested) and a "show more" toggle
- Uses `useEffect` with a 1-second interval to keep busy durations updating in real time
- The 1-second timer runs while any session is active according to runtime state, so active durations update for model requests and tool execution without treating `waiting` as busy.

## Integration

- Receives only navigation/focus callbacks from its parent; the view owns its bounded query/cache lifecycle.
- The Code `foxwarmEmbed=agents` leaf lazily reuses this component inside a stable Agents custom editor and bridges selection to deterministic chat editors without owning another global Session mirror.
- Global SSE subscribes only to loaded Architecture rows for immediate state/deletion deltas, retaining one invalidation-only stream while the row set is empty. Catalog invalidation refetches the current bounded root window through the fixed refresh scheduler; each new/reconnected batch also submits that scheduler's post-open resync, so replacement gaps close while sibling opens coalesce and stable subscription signatures do not loop.
- Agent changes clear historical rows, branches, expansion, summaries, refs, and epochs before loading the new forest; collapse and root-window changes prune unreachable descendants.
- The current Session is independently loaded by exact ID with its presentation path. In unfiltered mode, off-page canonical path rows become a forced bounded ownership/render chain. Under an agent filter, a different-agent focus is not forced; a matching focus keeps only its contiguous same-agent suffix after the nearest cross-agent boundary, preserving the filtered real forest without duplicate roots/edges. Initial path arrival, navigation, or canonical reparenting reveals the strict ancestor path once; replay of the same focus identity cannot reopen a branch the user collapsed afterward.
- `onSelectSession` navigates to a specific session's detail/chat view
- `onBack` triggers navigation back to a previous view (rendered as a back button in the header)
- Depends on the `Session` projection interface from `SessionListCore` and the fixed bounded Session-list APIs.
