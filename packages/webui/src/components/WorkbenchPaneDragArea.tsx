import { useId, type HTMLAttributes } from 'react'
import { useDraggable } from '@dnd-kit/core'

export function isWorkbenchPaneDragBlankTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && !!target.closest('[data-workbench-pane-drag-area]')
    && target.matches('[data-workbench-pane-drag-area], [data-workbench-pane-drag-blank]')
}

export default function WorkbenchPaneDragArea({ paneId, enabled, onPointerDown, onMouseDown, ...props }: HTMLAttributes<HTMLDivElement> & {
  paneId: string | null
  enabled: boolean
}) {
  const fallbackId = useId()
  const { setNodeRef, listeners } = useDraggable({
    id: enabled && paneId ? `pane-drag:${paneId}` : `pane-drag-disabled:${fallbackId}`,
    disabled: !enabled || !paneId,
    data: { type: 'pane', paneId },
  })
  return <div {...props} ref={setNodeRef}
    data-workbench-pane-drag-area={enabled && paneId ? paneId : undefined}
    onPointerDown={event => {
      onPointerDown?.(event)
      if (!event.defaultPrevented && isWorkbenchPaneDragBlankTarget(event.target)) listeners?.onPointerDown?.(event)
    }}
    onMouseDown={event => {
      if (isWorkbenchPaneDragBlankTarget(event.target)) event.stopPropagation()
      else onMouseDown?.(event)
    }} />
}