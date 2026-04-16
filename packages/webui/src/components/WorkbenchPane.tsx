import type { ReactNode } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { ArrowRightLeft, Columns2, Rows2, X } from 'lucide-react'
import WorkbenchTabs from './WorkbenchTabs'
import type { WorkbenchTab } from '../workbench/types'

interface WorkbenchPaneProps {
  paneId: string
  tabs: WorkbenchTab[]
  activeTabId: string | null
  focused: boolean
  dragEnabled?: boolean
  canClosePane: boolean
  canMoveActiveTab: boolean
  content: ReactNode
  onFocusPane: (paneId: string) => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onPinTab: (tabId: string) => void
  onUnpinTab: (tabId: string) => void
  onCloseAllTabs: () => void
  onCloseAllPinnedTabs: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  onMoveActiveTab: () => void
  onClosePane: () => void
}

function PaneDropZone({ id, className, activeClassName, data }: { id: string; className: string; activeClassName: string; data: Record<string, unknown> }) {
  const { setNodeRef, isOver } = useDroppable({ id, data })
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? activeClassName : ''}`} />
  )
}

function ToolbarButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
      title={title}
    >
      {children}
    </button>
  )
}

export default function WorkbenchPane({
  paneId,
  tabs,
  activeTabId,
  focused,
  dragEnabled = true,
  canClosePane,
  canMoveActiveTab,
  content,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onKeepTab,
  onPinTab,
  onUnpinTab,
  onCloseAllTabs,
  onCloseAllPinnedTabs,
  onSplitRight,
  onSplitDown,
  onMoveActiveTab,
  onClosePane,
}: WorkbenchPaneProps) {
  const hasActiveTab = !!activeTabId
  const { active } = useDndContext()
  const dragActive = !!active

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col overflow-hidden border ${focused ? 'border-blue-300 shadow-[0_0_0_1px_rgba(59,130,246,0.25)] dark:border-blue-500/60' : 'border-gray-200 dark:border-gray-700'}`}
      onMouseDown={() => onFocusPane(paneId)}
    >
      <WorkbenchTabs
        paneId={paneId}
        tabs={tabs}
        activeTabId={activeTabId}
        focused={focused}
        dragEnabled={dragEnabled}
        toolbar={(
          <>
            <ToolbarButton title="Split right with active tab" disabled={!hasActiveTab} onClick={onSplitRight}>
              <Columns2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="Split down with active tab" disabled={!hasActiveTab} onClick={onSplitDown}>
              <Rows2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="Move active tab to another pane" disabled={!hasActiveTab || !canMoveActiveTab} onClick={onMoveActiveTab}>
              <ArrowRightLeft className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="Close pane" disabled={!canClosePane} onClick={onClosePane}>
              <X className="h-4 w-4" />
            </ToolbarButton>
          </>
        )}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onKeepTab={onKeepTab}
        onPinTab={onPinTab}
        onUnpinTab={onUnpinTab}
        onCloseAllTabs={onCloseAllTabs}
        onCloseAllPinnedTabs={onCloseAllPinnedTabs}
      />

      <div className="min-h-0 flex-1 overflow-hidden bg-gray-100 dark:bg-gray-900">
        {content}
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-20">
          <PaneDropZone
            id={`pane-center:${paneId}`}
            data={{ type: 'pane-center', paneId }}
            className="absolute inset-3 rounded-xl border-2 border-transparent bg-transparent transition"
            activeClassName="border-blue-400/70 bg-blue-500/10 dark:border-blue-500/60 dark:bg-blue-500/10"
          />
          <PaneDropZone
            id={`pane-edge:${paneId}:left`}
            data={{ type: 'pane-edge', paneId, edge: 'left' }}
            className="absolute inset-y-0 left-0 w-8 rounded-l-xl border-2 border-transparent"
            activeClassName="border-blue-400/70 bg-blue-500/10 dark:border-blue-500/60 dark:bg-blue-500/10"
          />
          <PaneDropZone
            id={`pane-edge:${paneId}:right`}
            data={{ type: 'pane-edge', paneId, edge: 'right' }}
            className="absolute inset-y-0 right-0 w-8 rounded-r-xl border-2 border-transparent"
            activeClassName="border-blue-400/70 bg-blue-500/10 dark:border-blue-500/60 dark:bg-blue-500/10"
          />
          <PaneDropZone
            id={`pane-edge:${paneId}:bottom`}
            data={{ type: 'pane-edge', paneId, edge: 'bottom' }}
            className="absolute inset-x-0 bottom-0 h-8 rounded-b-xl border-2 border-transparent"
            activeClassName="border-blue-400/70 bg-blue-500/10 dark:border-blue-500/60 dark:bg-blue-500/10"
          />
        </div>
      )}
    </div>
  )
}