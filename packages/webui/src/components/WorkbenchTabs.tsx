import { useEffect, useRef } from 'react'
import { FileText, FolderOpen, MessageSquareText, SquareTerminal, X } from 'lucide-react'

export type WorkbenchTab =
  | { id: string; type: 'chat'; title: string; sessionId: string }
  | { id: string; type: 'workspace'; title: string; nodeId: string; path: string; contextSessionId?: string }
  | { id: string; type: 'file'; title: string; nodeId: string; path: string; contextSessionId?: string }
  | { id: string; type: 'terminal'; title: string; terminalId?: string; nodeId?: string; cwd?: string; contextSessionId?: string; createMode?: 'new' | 'reuse' }

interface WorkbenchTabsProps {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
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

export default function WorkbenchTabs({ tabs, activeTabId, onSelectTab, onCloseTab }: WorkbenchTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())

  useEffect(() => {
    if (!activeTabId) return

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
    <div className="overflow-hidden border-b border-gray-200 bg-gray-100 px-3 pt-2 dark:border-gray-700 dark:bg-gray-900">
      <div
        ref={containerRef}
        onWheel={handleWheel}
        className="flex min-w-0 items-end gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-px"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(tab.id, node)
                } else {
                  tabRefs.current.delete(tab.id)
                }
              }}
              role="button"
              tabIndex={0}
              onClick={() => onSelectTab(tab.id)}
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
              className={`group relative -mb-px flex min-w-[120px] max-w-[24rem] shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 px-3 py-2 text-sm transition-colors ${active ? 'border-gray-200 bg-white text-blue-700 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-blue-200' : 'border-transparent bg-gray-200/70 text-gray-700 hover:bg-white/70 dark:bg-gray-800/70 dark:text-gray-300 dark:hover:bg-gray-800'}`}
              title={tab.title}
            >
              <TabIcon type={tab.type} />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
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
        })}
      </div>
    </div>
  )
}