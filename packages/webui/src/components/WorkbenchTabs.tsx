import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { Bookmark, Copy, FileText, FolderOpen, MessageSquareText, Pin, PinOff, SquareTerminal, X } from 'lucide-react'
import ContextMenu, { type ContextMenuAnchorRect, type ContextMenuEntry } from './ContextMenu'
import type { WorkbenchTab } from '../workbench/types'

interface WorkbenchTabsProps {
  paneId: string
  tabs: WorkbenchTab[]
  activeTabId: string | null
  focused?: boolean
  toolbar?: ReactNode
  dragEnabled?: boolean
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onPinTab: (tabId: string) => void
  onUnpinTab: (tabId: string) => void
  onCloseAllTabs: () => void
  onCloseAllPinnedTabs: () => void
}

interface TabContextMenuState {
  tabId: string
  x: number
  y: number
  anchorRect?: ContextMenuAnchorRect
  preferredPlacement?: 'point' | 'bottom-start' | 'bottom-end'
}

function TabIcon({ type }: { type: WorkbenchTab['type'] }) {
  if (type === 'chat') return <MessageSquareText className="h-4 w-4 shrink-0" />
  if (type === 'workspace') return <FolderOpen className="h-4 w-4 shrink-0" />
  if (type === 'file') return <FileText className="h-4 w-4 shrink-0" />
  return <SquareTerminal className="h-4 w-4 shrink-0" />
}

function isHorizontallyFullyVisible(element: HTMLElement, container: HTMLElement) {
  const elementRect = element.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()

  return elementRect.left >= containerRect.left && elementRect.right <= containerRect.right
}

function getNormalizedWheelDelta(event: React.WheelEvent<HTMLDivElement>, container: HTMLDivElement) {
  if (event.deltaMode === 1) {
    return event.deltaY * 16
  }

  if (event.deltaMode === 2) {
    return event.deltaY * container.clientWidth
  }

  return event.deltaY
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fallback below
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function getTabCopyId(tab: WorkbenchTab) {
  if (tab.type === 'chat') return tab.sessionId
  return tab.id
}

function getTabCopyPath(tab: WorkbenchTab) {
  if (tab.type === 'workspace' || tab.type === 'file') return tab.path
  if (tab.type === 'terminal') return tab.cwd || null
  return null
}

function TabStripRow({
  paneId,
  dragEnabled,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onKeepTab,
  onOpenContextMenu,
  isPinnedRow,
}: {
  paneId: string
  dragEnabled: boolean
  tabs: WorkbenchTab[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onOpenContextMenu: (tabId: string, event: React.MouseEvent<HTMLDivElement>) => void
  isPinnedRow: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const { active } = useDndContext()
  const activeData = active?.data.current as { type?: string; pinned?: boolean } | undefined
  const { setNodeRef, isOver } = useDroppable({
    id: `tab-row:${paneId}:${isPinnedRow ? 'pinned' : 'regular'}`,
    data: {
      type: 'tab-row',
      paneId,
      pinned: isPinnedRow,
    },
  })

  const isDraggingTab = activeData?.type === 'tab'
  const activePinned = !!activeData?.pinned
  const shouldShowEmptyDropHint = tabs.length === 0 && isDraggingTab && activePinned !== isPinnedRow

  useEffect(() => {
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) return

    const container = containerRef.current
    const activeTabElement = tabRefs.current.get(activeTabId)

    if (!container || !activeTabElement) return

    const frame = window.requestAnimationFrame(() => {
      if (!isHorizontallyFullyVisible(activeTabElement, container)) {
        activeTabElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs])

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = containerRef.current

    if (!container || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) {
      return
    }

    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth)
    if (maxScrollLeft === 0) {
      return
    }

    const delta = getNormalizedWheelDelta(event, container)
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, container.scrollLeft + delta))

    if (nextScrollLeft !== container.scrollLeft) {
      event.preventDefault()
      container.scrollLeft = nextScrollLeft
    }
  }

  return (
    <div
      ref={setNodeRef}
      className={`${isPinnedRow ? 'border-b border-gray-200/80 pb-1 dark:border-gray-700/80' : 'pb-px'} ${isOver ? 'rounded-lg bg-blue-500/5 dark:bg-blue-500/10' : ''}`}
    >
      <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
        <div
          ref={containerRef}
          onWheel={handleWheel}
          className="flex min-w-0 items-end gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
        >
          {tabs.map((tab) => (
            <SortableTab
              key={tab.id}
              paneId={paneId}
              dragEnabled={dragEnabled}
              tab={tab}
              active={tab.id === activeTabId}
              setTabRef={(node) => {
                if (node) {
                  tabRefs.current.set(tab.id, node)
                } else {
                  tabRefs.current.delete(tab.id)
                }
              }}
              onSelectTab={onSelectTab}
              onKeepTab={onKeepTab}
              onOpenContextMenu={onOpenContextMenu}
              onCloseTab={onCloseTab}
            />
          ))}
          {shouldShowEmptyDropHint && (
            <div className="flex h-9 min-w-[120px] items-center justify-center rounded-lg border border-dashed border-blue-300 px-3 text-xs font-medium text-blue-700 dark:border-blue-500/60 dark:text-blue-200">
              {isPinnedRow ? 'Drop to pin' : 'Drop to unpin'}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

function SortableTab({
  paneId,
  dragEnabled,
  tab,
  active,
  setTabRef,
  onSelectTab,
  onKeepTab,
  onOpenContextMenu,
  onCloseTab,
}: {
  paneId: string
  dragEnabled: boolean
  tab: WorkbenchTab
  active: boolean
  setTabRef: (node: HTMLDivElement | null) => void
  onSelectTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onOpenContextMenu: (tabId: string, event: React.MouseEvent<HTMLDivElement>) => void
  onCloseTab: (tabId: string) => void
}) {
  const isPreview = tab.type === 'chat' && tab.preview
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    disabled: !dragEnabled,
    data: {
      type: 'tab',
      paneId,
      pinned: !!tab.pinned,
    },
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        setTabRef(node)
      }}
      style={style}
      onClick={() => onSelectTab(tab.id)}
      onDoubleClick={() => onKeepTab(tab.id)}
      onContextMenu={(event) => onOpenContextMenu(tab.id, event)}
      onMouseUp={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          onCloseTab(tab.id)
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelectTab(tab.id)
        }
      }}
      className={`group relative -mb-px flex min-w-[88px] max-w-[12rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 py-2 text-sm transition-colors ${active ? 'border-gray-200 bg-white text-blue-700 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-blue-200' : 'border-transparent bg-gray-200/70 text-gray-700 hover:bg-white/70 dark:bg-gray-800/70 dark:text-gray-300 dark:hover:bg-gray-800'} ${isDragging ? 'opacity-50' : ''}`}
      title={isPreview ? `${tab.title} (preview)` : tab.title}
      {...attributes}
      {...listeners}
    >
      <TabIcon type={tab.type} />
      <span className={`min-w-0 flex-1 truncate text-left [direction:rtl] ${isPreview ? 'italic' : ''}`}>{tab.title}</span>
      <button
        onClick={(event) => {
          event.stopPropagation()
          onCloseTab(tab.id)
        }}
        className="rounded p-0.5 text-gray-400 opacity-70 hover:bg-black/5 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-gray-200"
        title="Close tab"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export default function WorkbenchTabs({
  paneId,
  tabs,
  activeTabId,
  focused: _focused = false,
  toolbar,
  dragEnabled = true,
  onSelectTab,
  onCloseTab,
  onKeepTab,
  onPinTab,
  onUnpinTab,
  onCloseAllTabs,
  onCloseAllPinnedTabs,
}: WorkbenchTabsProps) {
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const { active } = useDndContext()

  const pinnedTabs = useMemo(() => tabs.filter((tab) => tab.pinned), [tabs])
  const regularTabs = useMemo(() => tabs.filter((tab) => !tab.pinned), [tabs])
  const activeData = active?.data.current as { type?: string } | undefined
  const isDraggingTab = activeData?.type === 'tab'
  const contextMenuTab = useMemo(
    () => (contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) || null : null),
    [contextMenu, tabs],
  )

  const menuEntries = useMemo<ContextMenuEntry[]>(() => {
    if (!contextMenuTab) return []

    const entries: ContextMenuEntry[] = []
    const copyPath = getTabCopyPath(contextMenuTab)

    if (contextMenuTab.type === 'chat' && contextMenuTab.preview) {
      entries.push({
        key: 'keep',
        label: 'Keep',
        icon: <Bookmark className="h-4 w-4" />,
        onSelect: () => onKeepTab(contextMenuTab.id),
      })
    }

    if (contextMenuTab.pinned) {
      entries.push({
        key: 'unpin',
        label: 'Unpin',
        icon: <PinOff className="h-4 w-4" />,
        onSelect: () => onUnpinTab(contextMenuTab.id),
      })
    } else {
      entries.push({
        key: 'pin',
        label: 'Pin',
        icon: <Pin className="h-4 w-4" />,
        onSelect: () => onPinTab(contextMenuTab.id),
      })
    }

    entries.push({
      key: 'copy-id',
      label: 'Copy id',
      icon: <Copy className="h-4 w-4" />,
      onSelect: () => {
        void copyTextToClipboard(getTabCopyId(contextMenuTab))
      },
    })

    if (copyPath) {
      entries.push({
        key: 'copy-path',
        label: 'Copy path',
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => {
          void copyTextToClipboard(copyPath)
        },
      })
    }

    entries.push({ key: 'separator-close', type: 'separator' })
    entries.push({
      key: 'close',
      label: 'Close',
      icon: <X className="h-4 w-4" />,
      danger: true,
      onSelect: () => onCloseTab(contextMenuTab.id),
    })

    if (contextMenuTab.pinned) {
      entries.push({ key: 'separator-bulk-close', type: 'separator' })
      entries.push({
        key: 'close-all-pinned',
        label: 'Close all pinned',
        icon: <X className="h-4 w-4" />,
        onSelect: onCloseAllPinnedTabs,
      })
    } else {
      entries.push({ key: 'separator-bulk-close', type: 'separator' })
      entries.push({
        key: 'close-all',
        label: 'Close all',
        icon: <X className="h-4 w-4" />,
        onSelect: onCloseAllTabs,
      })
    }

    return entries
  }, [contextMenuTab, onCloseAllPinnedTabs, onCloseAllTabs, onCloseTab, onKeepTab, onPinTab, onUnpinTab])

  const openContextMenu = (tabId: string, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      tabId,
      x: event.clientX,
      y: event.clientY,
      preferredPlacement: 'point',
    })
  }

  return (
    <div className="overflow-hidden border-b border-gray-200 bg-gray-100 px-3 pt-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {(pinnedTabs.length > 0 || isDraggingTab) && (
            <TabStripRow
              paneId={paneId}
              dragEnabled={dragEnabled}
              tabs={pinnedTabs}
              activeTabId={activeTabId}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              onKeepTab={onKeepTab}
              onOpenContextMenu={openContextMenu}
              isPinnedRow
            />
          )}
          <TabStripRow
            paneId={paneId}
            dragEnabled={dragEnabled}
            tabs={regularTabs}
            activeTabId={activeTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onKeepTab={onKeepTab}
            onOpenContextMenu={openContextMenu}
            isPinnedRow={false}
          />
        </div>
        {toolbar && (
          <div className="flex shrink-0 items-center gap-1">
            {toolbar}
          </div>
        )}
      </div>
      <ContextMenu
        open={!!contextMenuTab}
        entries={menuEntries}
        point={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        anchorRect={contextMenu?.anchorRect || null}
        preferredPlacement={contextMenu?.preferredPlacement || 'point'}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}

export type { WorkbenchTab } from '../workbench/types'