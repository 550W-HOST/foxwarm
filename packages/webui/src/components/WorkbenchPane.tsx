import type { ReactNode } from 'react'
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core'
import { Columns2, GripVertical, PanelLeftClose, PanelLeftOpen, PanelTopClose, PanelTopOpen, Rows2, X } from 'lucide-react'
import WorkbenchTabs from './WorkbenchTabs'
import { WorkbenchTabHeaderProvider } from './WorkbenchTabHeader'
import WorkbenchTabErrorBoundary from './WorkbenchTabErrorBoundary'
import { useWorkbenchTabMenu } from './useWorkbenchTabMenu'
import type { WorkbenchTab } from '../workbench/types'

interface WorkbenchPaneProps {
  paneId: string
  collapseDirection: 'row' | 'column'
  tabs: WorkbenchTab[]
  activeTabId: string | null
  collapsed: boolean
  focused: boolean
  emphasizeFocus?: boolean
  dragEnabled?: boolean
  showPaneControls?: boolean
  hideTabStrip?: boolean
  canClosePane: boolean
  canCloseActiveTab?: boolean
  renderContent: () => ReactNode
  onFocusPane: (paneId: string) => void
  onSetCollapsed: (paneId: string, collapsed: boolean) => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onMoveTabToNewWindow: (tabId: string) => void
  canMoveTabToNewWindow: (tabId: string) => boolean
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  onClosePane: () => void
}

const toolbarButtonClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-fw-border bg-fw-surface text-fw-text transition hover:bg-fw-hover hover:text-fw-text-strong disabled:cursor-not-allowed disabled:opacity-40 dark:border-fw-border dark:bg-fw-surface dark:text-fw-text dark:hover:bg-fw-hover'

function ToolbarButton({ title, disabled, onClick, children, collapseMarker }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode; collapseMarker?: string }) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onClick}
      disabled={disabled}
      data-workbench-pane-collapse={collapseMarker}
      className={toolbarButtonClass}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  )
}

function PaneDragHandle({ paneId }: { paneId: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pane-drag:${paneId}`,
    data: { type: 'pane', paneId },
  })
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onMouseDown={(event) => event.stopPropagation()}
      data-workbench-pane-drag-handle={paneId}
      className={`${toolbarButtonClass} touch-none select-none cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-50' : ''}`}
      title="Drag pane"
      aria-label="Drag pane"
    >
      <GripVertical className="h-4 w-4" />
    </button>
  )
}

function PaneDropZone({ paneId, edge, className }: { paneId: string; edge?: 'left' | 'right' | 'top' | 'bottom'; className: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: edge ? `pane-edge:${paneId}:${edge}` : `pane-center:${paneId}`,
    data: edge ? { type: 'pane-edge', paneId, edge } : { type: 'pane-center', paneId },
  })
  return (
    <div
      ref={setNodeRef}
      data-workbench-pane-drop={edge || 'center'}
      className={`${className} border-2 border-transparent ${isOver ? 'border-fw-accent-border/70 bg-fw-accent/10 dark:border-fw-accent-border/60' : ''}`}
    />
  )
}

function PaneDropTargets({ paneId }: { paneId: string }) {
  const { active } = useDndContext()
  if (!active) return null
  const draggingPane = active.data.current?.type === 'pane'
  if (draggingPane && active.data.current?.paneId === paneId) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[80]">
      {!draggingPane && <PaneDropZone paneId={paneId} className="absolute inset-3 rounded-xl" />}
      <PaneDropZone paneId={paneId} edge="left" className="absolute inset-y-0 left-0 w-14 max-w-[25%] rounded-l-xl" />
      <PaneDropZone paneId={paneId} edge="right" className="absolute inset-y-0 right-0 w-14 max-w-[25%] rounded-r-xl" />
      {draggingPane && <PaneDropZone paneId={paneId} edge="top" className="absolute inset-x-0 top-0 h-12 max-h-[25%] rounded-t-xl" />}
      <PaneDropZone paneId={paneId} edge="bottom" className="absolute inset-x-0 bottom-0 h-12 max-h-[25%] rounded-b-xl" />
    </div>
  )
}

function RenderedPaneContent({ renderContent }: { renderContent: () => ReactNode }) {
  return <>{renderContent()}</>
}

export default function WorkbenchPane({
  paneId,
  collapseDirection,
  tabs,
  activeTabId,
  collapsed,
  focused,
  emphasizeFocus = true,
  dragEnabled = true,
  showPaneControls = true,
  hideTabStrip = false,
  canClosePane,
  canCloseActiveTab = true,
  renderContent,
  onFocusPane,
  onSetCollapsed,
  onSelectTab,
  onCloseTab,
  onKeepTab,
  onMoveTabToNewWindow,
  canMoveTabToNewWindow,
  onCloseOtherTabs,
  onCloseAllTabs,
  onSplitRight,
  onSplitDown,
  onClosePane,
}: WorkbenchPaneProps) {
  const { openContextMenu, openMenuAtElement, menu } = useWorkbenchTabMenu({ tabs, onCloseTab, onKeepTab, onMoveTabToNewWindow, canMoveTabToNewWindow, onCloseOtherTabs, onCloseAllTabs })
  const verticalRail = collapseDirection === 'row'
  const containerChromeClass = emphasizeFocus
    ? (focused ? 'border-fw-accent-border ring-1 ring-fw-accent/25 dark:border-fw-accent-border/60' : 'border-fw-border')
    : 'border-transparent shadow-none'
  const paneControls = (
    <>
      {dragEnabled && <PaneDragHandle paneId={paneId} />}
      <ToolbarButton
        title={collapsed ? 'Expand pane' : 'Collapse pane'}
        collapseMarker={paneId}
        onClick={() => onSetCollapsed(paneId, !collapsed)}
      >
        {verticalRail
          ? collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />
          : collapsed ? <PanelTopOpen className="h-4 w-4" /> : <PanelTopClose className="h-4 w-4" />}
      </ToolbarButton>
      {canClosePane && (
        <ToolbarButton title="Close pane" onClick={onClosePane}>
          <X className="h-4 w-4" />
        </ToolbarButton>
      )}
    </>
  )
  const header = hideTabStrip && tabs.length === 1
    ? { tab: tabs[0], paneId, dragEnabled, paneControls, onCloseTab, onKeepTab, openContextMenu, openMenuAtElement }
    : null

  return (
    <div
      data-pane-id={paneId}
      data-workbench-collapsed-pane={collapsed ? 'true' : undefined}
      className={`relative flex min-h-0 min-w-0 overflow-hidden border ${containerChromeClass} ${collapsed ? verticalRail ? 'h-full w-12 flex-col' : 'h-10 w-full flex-row items-center' : 'h-full flex-col'}`}
      onMouseDown={() => onFocusPane(paneId)}
    >
      {collapsed ? (
        <>
          <div
            role="tablist"
            aria-label="Pane tabs"
            aria-orientation={verticalRail ? 'vertical' : 'horizontal'}
            className={`flex min-h-0 min-w-0 flex-1 gap-1 bg-fw-neutral-surface dark:bg-fw-canvas ${verticalRail ? 'flex-col items-center overflow-y-auto px-1 py-2' : 'items-center overflow-x-auto px-2'}`}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                title={`${tab.title} — expand pane`}
                data-workbench-collapsed-tab={tab.id}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => {
                  onSetCollapsed(paneId, false)
                  onSelectTab(tab.id)
                }}
                className={`flex shrink-0 items-center justify-center rounded-md px-2 text-xs transition ${tab.id === activeTabId ? 'bg-fw-accent/15 font-semibold text-fw-accent' : 'text-fw-text hover:bg-fw-hover hover:text-fw-text-strong'} ${verticalRail ? 'min-h-9 w-full py-2' : 'h-8 max-w-48'}`}
              >
                <span className={verticalRail ? 'text-center [writing-mode:vertical-rl]' : 'truncate'}>{tab.title}</span>
              </button>
            ))}
          </div>
          <div className={`flex shrink-0 items-center gap-1 p-1 ${verticalRail ? 'flex-col' : ''}`}>
            {paneControls}
          </div>
        </>
      ) : (
        <>
          {!hideTabStrip && (
            <WorkbenchTabs
              paneId={paneId}
              tabs={tabs}
              activeTabId={activeTabId}
              focused={focused}
              dragEnabled={dragEnabled}
              toolbar={(
                <>
                  {showPaneControls && tabs.length !== 1 && (
                    <>
                      <ToolbarButton title="Split right with active tab" disabled={!activeTabId} onClick={onSplitRight}>
                        <Columns2 className="h-4 w-4" />
                      </ToolbarButton>
                      <ToolbarButton title="Split down with active tab" disabled={!activeTabId} onClick={onSplitDown}>
                        <Rows2 className="h-4 w-4" />
                      </ToolbarButton>
                    </>
                  )}
                  {paneControls}
                </>
              )}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              onKeepTab={onKeepTab}
              onMoveTabToNewWindow={onMoveTabToNewWindow}
              canMoveTabToNewWindow={canMoveTabToNewWindow}
              onCloseOtherTabs={onCloseOtherTabs}
              onCloseAllTabs={onCloseAllTabs}
            />
          )}
          <div className="min-h-0 flex-1 overflow-hidden bg-fw-canvas">
            <WorkbenchTabHeaderProvider value={header}>
              <WorkbenchTabErrorBoundary
                key={`${paneId}:${activeTabId || 'empty'}`}
                tabId={activeTabId || 'empty'}
                tabTitle={tabs.find((tab) => tab.id === activeTabId)?.title || 'tab'}
                canClose={!!activeTabId && canCloseActiveTab}
                onClose={() => { if (activeTabId) onCloseTab(activeTabId) }}
              >
                <RenderedPaneContent renderContent={renderContent} />
              </WorkbenchTabErrorBoundary>
            </WorkbenchTabHeaderProvider>
          </div>
        </>
      )}
      {menu}
      <PaneDropTargets paneId={paneId} />
    </div>
  )
}
