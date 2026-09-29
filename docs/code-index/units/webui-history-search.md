# Unit: webui-history-search

Files: packages/webui/src/components/HistorySearchView.tsx, packages/webui/test/historySearchViewer.e2e.mjs
Secondary files: packages/webui/src/App.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/components/Sidebar.tsx, packages/webui/src/components/CollapsedSidebar.tsx, packages/webui/src/components/SessionList.tsx, packages/webui/src/workbench/types.ts, packages/webui/src/workbench/utils.ts

## Purpose

The independent workbench Search tab shows authenticated Archive search groups and exact Session message references using the existing ChatTimeline without mounting Chat, its composer or its realtime subscription. Global search defaults to every Agent and Session; optional Agent and Session inputs narrow the source. A copied `sessionId=... msg#N-M` reference selects its Session directly; a bare `msg#N` requires a selected Session.

## Functions and behavior

- `HistorySearchView` owns the query form and one result list; every result contains independent earlier/later loading state, errors, sequence anchors and one Timeline. Block/fact hits display an actual expandable CTX-BLOCK; a missing source shows a labeled cached excerpt rather than a fabricated message.
- `readHistory` calls deployment-relative authenticated GET routes. `mergeMessages` deduplicates sequence IDs when appending/prepending archive pages.
- Query changes, scope changes, unmount and new submissions invalidate/abort old requests; late responses cannot replace current results. No browser-global search state is required.
- `App` opens one restorable `system:search` tab from expanded/collapsed/mobile navigation. Popout uses the existing leaf route and renders the same viewer. The ChatTimeline/ToolTimelineItems rendering and Chat-local search mechanics remain unchanged.
- Browser fixtures verify Timeline grouping, independent paging, tool/CTX/image behavior, reference paste and deployment subpath. Backend HTTP fixtures and the shared source contract are described in [context compaction and recall](../threads/context-compaction-and-recall.md#d-context-history-search-viewer).