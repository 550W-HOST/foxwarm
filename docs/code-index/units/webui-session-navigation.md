# Unit: Session list, architecture, sidebar, search, and bounded replay

Files: `packages/webui/src/architectureOperations.ts`, `packages/webui/src/boundedSessionList.ts`, `packages/webui/src/boundedSessionReplay.ts`, `packages/webui/src/components/ArchitectureView.tsx`, `packages/webui/src/components/CollapsedSidebar.tsx`, `packages/webui/src/components/CollapsedSidebarContainer.tsx`, `packages/webui/src/components/ContentHeader.tsx`, `packages/webui/src/components/ContextMenu.tsx`, `packages/webui/src/components/CreateTabButton.tsx`, `packages/webui/src/components/HistorySearchView.tsx`, `packages/webui/src/components/SessionDebugModal.tsx`, `packages/webui/src/components/SessionList.tsx`, `packages/webui/src/components/SessionListCore.tsx`, `packages/webui/src/components/Sidebar.tsx`, `packages/webui/src/sessionIdleAttention.ts`, `packages/webui/src/sessionIdleNotifications.ts`, `packages/webui/src/sessionListDensity.ts`, `packages/webui/src/sessionListDrag.ts`, `packages/webui/src/sessionListPresentation.ts`, `packages/webui/src/sessionListRefresh.ts`

## Purpose

Maintains bounded session list/replay, sidebar/architecture navigation, session drag/presentation state, search/debug surfaces, and idle attention.

## Stable symbols and callers

`SessionListCore`; `SessionList`; `ArchitectureView`; bounded list/replay helpers; sidebar presentation state.

Callers and boundary: `App`/`Sidebar`; bounded session and architecture APIs from `WebUIChannel`.

## Behavior and side effects

`SessionListCore` merges cursor pages, refresh revisions, drag/presentation updates, and idle attention; `ArchitectureView` uses bounded parent/child/agent queries. Sidebar collapse/search/debug components only change browser navigation/presentation; they never infer active history from a list row or Archive.

## Tests

Bounded list, session-list, sidebar lifecycle, architecture, drag, history-search, and debug tests.
