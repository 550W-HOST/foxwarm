import HistorySearchView, { type HistorySearchDraft } from './HistorySearchView'
import { WorkbenchPaneToolbar } from './WorkbenchPane'
import { useWorkbenchTabMenu } from './useWorkbenchTabMenu'
import type { WorkbenchTabHeaderValue } from './WorkbenchTabHeader'
import type { WorkbenchPaneNode, WorkbenchTab } from '../workbench/types'
import type { TimelineView } from '../chatPreferences'
import { useCallback, useLayoutEffect, useState } from 'react'

export default function HistorySearchTabHost({
  tab,
  pane,
  paneId,
  collapseDirection,
  slot,
  isMobile,
  timelineView,
  showUsageBadge,
  showUserMessageMetadata,
  knownSessions,
  onBack,
  onOpenSession,
  onDraftChange,
  onSearchStarted,
  onScrollTopChange,
  scrollTop,
  onSetCollapsed,
  canClosePane,
  onClosePane,
  onCloseTab,
  onKeepTab,
  onMoveTabToNewWindow,
  canMoveTabToNewWindow,
  onCloseOtherTabs,
  onCloseAllTabs,
}: {
  tab: Extract<WorkbenchTab, { type: 'search' }>
  pane: WorkbenchPaneNode | null
  paneId: string | null
  collapseDirection: 'row' | 'column'
  slot: HTMLElement | null
  isMobile: boolean
  timelineView: TimelineView
  showUsageBadge: boolean
  showUserMessageMetadata: boolean
  knownSessions: string[]
  onBack?: () => void
  onOpenSession?: (sessionId: string) => void
  onDraftChange: (draft: HistorySearchDraft) => void
  onSearchStarted: () => void
  onScrollTopChange: (scrollTop: number) => void
  scrollTop: number
  onSetCollapsed: (paneId: string, collapsed: boolean) => void
  canClosePane: boolean
  onClosePane: () => void
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onMoveTabToNewWindow: (tabId: string) => void
  canMoveTabToNewWindow: (tabId: string) => boolean
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
}) {
  const { openContextMenu, openMenuAtElement, menu } = useWorkbenchTabMenu({
    tabs: [tab],
    onCloseTab,
    onKeepTab,
    onMoveTabToNewWindow,
    canMoveTabToNewWindow,
    onCloseOtherTabs,
    onCloseAllTabs,
  })
  const header: WorkbenchTabHeaderValue | null = paneId && pane && pane.tabIds.length === 1 ? {
    tab,
    paneId,
    dragEnabled: !isMobile,
    paneControls: <WorkbenchPaneToolbar
      paneId={paneId}
      collapsed={pane.collapsed}
      verticalRail={collapseDirection === 'row'}
      canClosePane={canClosePane}
      dragEnabled={!isMobile}
      onSetCollapsed={onSetCollapsed}
      onClosePane={onClosePane}
    />,
    onCloseTab,
    onKeepTab,
    openContextMenu,
    openMenuAtElement,
  } : null

  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const setPortalRef = useCallback((element: HTMLDivElement | null) => setPortalTarget(element), [])
  useLayoutEffect(() => {
    const host = portalTarget
    if (!host) return
    let frame = 0
    const updatePosition = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        if (!slot?.isConnected) {
          host.style.visibility = 'hidden'
          host.style.pointerEvents = 'none'
          return
        }
        const rect = slot.getBoundingClientRect()
        const visible = rect.width > 0 && rect.height > 0
        host.style.left = `${Math.max(0, rect.left)}px`
        host.style.top = `${Math.max(0, rect.top)}px`
        host.style.width = `${Math.max(0, rect.width)}px`
        host.style.height = `${Math.max(0, rect.height)}px`
        host.style.visibility = visible ? 'visible' : 'hidden'
        host.style.pointerEvents = visible ? 'auto' : 'none'
      })
    }
    const observer = slot ? new ResizeObserver(updatePosition) : null
    if (observer && slot) observer.observe(slot)
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    updatePosition()
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [portalTarget, slot])

  return <>
    <div ref={setPortalRef} className="fixed z-30 overflow-hidden" style={{ visibility: 'hidden', pointerEvents: 'none' }} data-history-search-portal={tab.id} />
    <HistorySearchView
      tabId={tab.id}
      isMobile={isMobile}
      timelineView={timelineView}
      showUsageBadge={showUsageBadge}
      showUserMessageMetadata={showUserMessageMetadata}
      knownSessions={knownSessions}
      onBack={onBack}
      onOpenSession={onOpenSession}
      initialDraft={{ query: tab.searchQuery || '', agentName: tab.searchAgentName || '', sessionId: tab.searchSessionId || '' }}
      onDraftChange={onDraftChange}
      onSearchStarted={onSearchStarted}
      portalTarget={portalTarget}
      scrollTop={scrollTop}
      onScrollTopChange={onScrollTopChange}
      header={header}
    />
    {menu}
  </>
}
