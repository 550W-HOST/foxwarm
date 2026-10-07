# Unit: Session list, architecture, sidebar, search, and bounded replay

Files: `packages/webui/src/architectureOperations.ts`, `packages/webui/src/boundedSessionList.ts`, `packages/webui/src/boundedSessionReplay.ts`, `packages/webui/src/components/ArchitectureView.tsx`, `packages/webui/src/components/CollapsedSidebar.tsx`, `packages/webui/src/components/CollapsedSidebarContainer.tsx`, `packages/webui/src/components/ContentHeader.tsx`, `packages/webui/src/components/ContextMenu.tsx`, `packages/webui/src/components/CreateTabButton.tsx`, `packages/webui/src/components/HistorySearchView.tsx`, `packages/webui/src/components/SessionDebugModal.tsx`, `packages/webui/src/components/SessionList.tsx`, `packages/webui/src/components/SessionListCore.tsx`, `packages/webui/src/components/Sidebar.tsx`, `packages/webui/src/sessionIdleAttention.ts`, `packages/webui/src/sessionIdleNotifications.ts`, `packages/webui/src/sessionListDensity.ts`, `packages/webui/src/sessionListDrag.ts`, `packages/webui/src/sessionListPresentation.ts`, `packages/webui/src/sessionListRefresh.ts`

## Purpose

Maintains bounded Session list/replay, sidebar/architecture navigation, search/debug surfaces, drag/presentation state, idle attention, and node indicators.

## Stable symbols and callers

`SessionListCore`; `SessionList`; `ArchitectureView`; `boundedSessionList`; `boundedSessionReplay`; `sessionListRefresh`; density/drag/presentation helpers; idle notification/attention helpers. Callers are `App`/`Sidebar` and the bounded catalog/architecture APIs from `WebUIChannel`.

## Behavior and side effects

Root, expanded-child, exact-row, and search windows use cursor/revision/generation gates; stale responses cannot overwrite a newer list snapshot. Sidebar rows remain bounded and presentation-oriented; active history is fetched through Chat/replay routes and is never rebuilt from a list row or Archive. Architecture view requests bounded parent/child/agent summaries and preserves operational topology rather than pretending every catalog row is an active owner.

Density and node indicators remain presentation contracts: list density is browser-local, while node indicators report the selected/available target without reassigning an unavailable remote ID to Master. Idle notifications/watchers observe accepted list snapshots and create only the latest visible-page notification per canonical Session. The collapsed desktop rail owns a separate 20-root controller only while conditionally mounted; expanded desktop/mobile surfaces create no hidden duplicate controller or logical realtime subscription.

## Tests

Bounded list/replay, session-list density/drag, sidebar/architecture, history-search, idle notification, and debug-surface browser tests.
