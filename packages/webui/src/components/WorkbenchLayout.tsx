import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Group, Panel, Separator, type Layout, usePanelRef } from 'react-resizable-panels'
import type { WorkbenchLayoutNode } from '../workbench/types'

interface WorkbenchLayoutProps {
  node: WorkbenchLayoutNode
  renderPane: (paneId: string, collapseDirection: 'row' | 'column') => ReactNode
  onLayoutResize: (splitId: string, sizes: number[]) => void
}

function ResizeHandle({ direction }: { direction: 'row' | 'column' }) {
  return (
    <Separator className={`group flex shrink-0 items-center justify-center ${direction === 'row' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}`}>
      <div className={`rounded-full bg-fw-border-strong transition group-hover:bg-fw-accent dark:bg-fw-surface-raised dark:group-hover:bg-fw-accent ${direction === 'row' ? 'h-10 w-1' : 'h-1 w-10'}`} />
    </Separator>
  )
}

function LayoutPanel({ child, direction, defaultSize, restoreSize, renderPane, onLayoutResize }: {
  child: WorkbenchLayoutNode
  direction: 'row' | 'column'
  defaultSize: number
  restoreSize: number
  renderPane: WorkbenchLayoutProps['renderPane']
  onLayoutResize: WorkbenchLayoutProps['onLayoutResize']
}) {
  const panelRef = usePanelRef()
  const collapsed = child.kind === 'pane' && child.collapsed
  const expandedSize = useRef(restoreSize)
  const wasCollapsed = useRef(false)
  const collapsedSize = direction === 'row' ? '48px' : '40px'

  useEffect(() => {
    if (collapsed && !wasCollapsed.current) expandedSize.current = restoreSize
    const size = collapsed ? collapsedSize : wasCollapsed.current ? `${expandedSize.current}%` : null
    wasCollapsed.current = collapsed
    if (!size) return
    // Panel constraint changes register a new layout before the imperative resize can restore it.
    const frame = window.requestAnimationFrame(() => panelRef.current?.resize(size))
    return () => window.cancelAnimationFrame(frame)
  }, [collapsed, collapsedSize, panelRef])

  return (
    <Panel
      id={child.id}
      panelRef={panelRef}
      defaultSize={defaultSize}
      minSize={collapsed ? collapsedSize : 15}
      maxSize={collapsed ? collapsedSize : undefined}
      className="min-h-0 min-w-0"
    >
      {child.kind === 'pane'
        ? renderPane(child.id, direction)
        : <WorkbenchLayout node={child} renderPane={renderPane} onLayoutResize={onLayoutResize} />}
    </Panel>
  )
}

export default function WorkbenchLayout({ node, renderPane, onLayoutResize }: WorkbenchLayoutProps) {
  const childIds = node.kind === 'split' ? node.children.map(child => child.id).join('|') : ''
  // Resizing belongs to the live Group; seed its defaults again only when the topology changes.
  const defaultLayout: Layout = useMemo(() => node.kind === 'split'
    ? Object.fromEntries(node.children.map((child, index) => [child.id, node.sizes[index] || 100 / node.children.length]))
    : {}, [node.id, childIds])

  if (node.kind === 'pane') return <>{renderPane(node.id, 'column')}</>

  if (node.children.every(child => child.kind === 'pane' && child.collapsed)) {
    return (
      <div className={`flex h-full min-h-0 min-w-0 gap-1.5 ${node.direction === 'row' ? 'flex-row' : 'flex-col'}`}>
        {node.children.map(child => <div key={child.id} className="shrink-0">{renderPane(child.id, node.direction)}</div>)}
      </div>
    )
  }

  return (
    <Group
      orientation={node.direction === 'row' ? 'horizontal' : 'vertical'}
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout: Layout) => onLayoutResize(node.id, node.children.map(child => Number(layout[child.id] || 0)))}
      className="h-full min-h-0 w-full min-w-0"
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          <LayoutPanel
            child={child}
            direction={node.direction}
            defaultSize={defaultLayout[child.id]}
            restoreSize={node.sizes[index] || defaultLayout[child.id]}
            renderPane={renderPane}
            onLayoutResize={onLayoutResize}
          />
          {index < node.children.length - 1 && <ResizeHandle direction={node.direction} />}
        </Fragment>
      ))}
    </Group>
  )
}
