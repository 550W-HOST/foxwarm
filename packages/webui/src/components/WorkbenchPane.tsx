import type { ReactNode } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { Columns2, Rows2, X } from 'lucide-react'
import WorkbenchTabs from './WorkbenchTabs'
import type { WorkbenchTab } from '../workbench/types'

interface WorkbenchPaneProps {
  paneId: string
  tabs: WorkbenchTab[]
  activeTabId: string | null
  focused: boolean
  emphasizeFocus?: boolean
  dragEnabled?: boolean
  showPaneControls?: boolean
  canClosePane: boolean
  content: ReactNode
  onFocusPane: (paneId: string) => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
  onSplitRight: () => void
  onSplitDown: () => void
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
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-fw-border bg-fw-surface text-fw-text transition hover:bg-fw-hover hover:text-fw-text-strong disabled:cursor-not-allowed disabled:opacity-40 dark:border-fw-border dark:bg-fw-surface dark:text-fw-text dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse"
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
  emphasizeFocus = true,
  dragEnabled = true,
  showPaneControls = true,
  canClosePane,
  content,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onKeepTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onSplitRight,
  onSplitDown,
  onClosePane,
}: WorkbenchPaneProps) {
  const hasActiveTab = !!activeTabId
  const { active } = useDndContext()
  const dragActive = !!active
  const containerChromeClass = emphasizeFocus
    ? (focused ? 'border-fw-accent-border ring-1 ring-fw-accent/25 dark:border-fw-accent-border/60' : 'border-fw-border')
    : 'border-transparent shadow-none'

  return (
    <div
      data-pane-id={paneId}
      className={`relative flex h-full min-h-0 flex-col overflow-hidden border ${containerChromeClass}`}
      onMouseDown={() => onFocusPane(paneId)}
    >
      <WorkbenchTabs
        paneId={paneId}
        tabs={tabs}
        activeTabId={activeTabId}
        focused={focused}
        dragEnabled={dragEnabled}
        toolbar={showPaneControls ? (
          <>
            <ToolbarButton title="Split right with active tab" disabled={!hasActiveTab} onClick={onSplitRight}>
              <Columns2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="Split down with active tab" disabled={!hasActiveTab} onClick={onSplitDown}>
              <Rows2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="Close pane" disabled={!canClosePane} onClick={onClosePane}>
              <X className="h-4 w-4" />
            </ToolbarButton>
          </>
        ) : null}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onKeepTab={onKeepTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseAllTabs={onCloseAllTabs}
      />

      <div className="min-h-0 flex-1 overflow-hidden bg-fw-canvas">
        {content}
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-[80]">
          <PaneDropZone
            id={`pane-center:${paneId}`}
            data={{ type: 'pane-center', paneId }}
            className="absolute inset-3 rounded-xl border-2 border-transparent bg-transparent transition"
            activeClassName="border-fw-accent-border/70 bg-fw-accent/10 dark:border-fw-accent-border/60 dark:bg-fw-accent/10"
          />
          <PaneDropZone
            id={`pane-edge:${paneId}:left`}
            data={{ type: 'pane-edge', paneId, edge: 'left' }}
            className="absolute inset-y-0 left-0 w-14 rounded-l-xl border-2 border-transparent"
            activeClassName="border-fw-accent-border/70 bg-fw-accent/10 dark:border-fw-accent-border/60 dark:bg-fw-accent/10"
          />
          <PaneDropZone
            id={`pane-edge:${paneId}:right`}
            data={{ type: 'pane-edge', paneId, edge: 'right' }}
            className="absolute inset-y-0 right-0 w-14 rounded-r-xl border-2 border-transparent"
            activeClassName="border-fw-accent-border/70 bg-fw-accent/10 dark:border-fw-accent-border/60 dark:bg-fw-accent/10"
          />
          <PaneDropZone
            id={`pane-edge:${paneId}:bottom`}
            data={{ type: 'pane-edge', paneId, edge: 'bottom' }}
            className="absolute inset-x-0 bottom-0 h-12 rounded-b-xl border-2 border-transparent"
            activeClassName="border-fw-accent-border/70 bg-fw-accent/10 dark:border-fw-accent-border/60 dark:bg-fw-accent/10"
          />
        </div>
      )}
    </div>
  )
}