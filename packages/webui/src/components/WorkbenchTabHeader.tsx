import { createContext, useContext, type MouseEvent, type ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { X } from 'lucide-react'
import type { WorkbenchTab } from '../workbench/types'

interface WorkbenchTabHeaderValue {
  tab: WorkbenchTab
  paneId: string
  dragEnabled: boolean
  paneControls: ReactNode
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  openContextMenu: (tabId: string, event: MouseEvent<HTMLElement>) => void
  openMenuAtElement: (tabId: string, element: HTMLElement) => void
}

const WorkbenchTabHeaderContext = createContext<WorkbenchTabHeaderValue | null>(null)
export const WorkbenchTabHeaderProvider = WorkbenchTabHeaderContext.Provider
export const useWorkbenchTabHeader = () => useContext(WorkbenchTabHeaderContext)

export function WorkbenchPaneControls() {
  const header = useWorkbenchTabHeader()
  return header ? <div className="ml-auto flex shrink-0 items-center gap-1" data-workbench-pane-controls>{header.paneControls}</div> : null
}

export function WorkbenchTabClose({ className, iconClassName = 'h-5 w-5' }: { className: string; iconClassName?: string }) {
  const header = useWorkbenchTabHeader()
  if (!header) return null
  return (
    <button
      type="button"
      data-workbench-tab-close={header.tab.id}
      className={className}
      title="Close tab"
      aria-label="Close tab"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); header.onCloseTab(header.tab.id) }}
    >
      <X className={iconClassName} />
    </button>
  )
}

function TabDragHandle({ header, children, className }: { header: WorkbenchTabHeaderValue; children: ReactNode; className?: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: header.tab.id,
    disabled: !header.dragEnabled,
    data: { type: 'tab', paneId: header.paneId },
  })
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-workbench-tab-handle={header.tab.id}
      className={`${className || ''} shrink-0 touch-none select-none ${header.dragEnabled ? 'cursor-grab active:cursor-grabbing' : ''}`}
      title="Tab actions"
      aria-label={`Tab actions: ${header.tab.title}`}
      aria-haspopup="menu"
      aria-disabled={false}
      onClick={event => { event.stopPropagation(); header.openMenuAtElement(header.tab.id, event.currentTarget) }}
      onContextMenu={event => header.openContextMenu(header.tab.id, event)}
      onDoubleClick={() => header.onKeepTab(header.tab.id)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          event.stopPropagation()
          header.openMenuAtElement(header.tab.id, event.currentTarget)
        }
      }}
    >
      {children}
    </button>
  )
}

export function WorkbenchTabIcon({ children, className }: { children: ReactNode; className?: string }) {
  const header = useWorkbenchTabHeader()
  return header
    ? <TabDragHandle header={header} className={className}>{children}</TabDragHandle>
    : <div className={className}>{children}</div>
}
