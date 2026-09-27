import { Fragment, type ReactNode } from 'react'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'
import type { WorkbenchLayoutNode } from '../workbench/types'

interface WorkbenchLayoutProps {
  node: WorkbenchLayoutNode
  renderPane: (paneId: string) => ReactNode
  onLayoutResize: (splitId: string, sizes: number[]) => void
}

function ResizeHandle({ direction }: { direction: 'row' | 'column' }) {
  return (
    <Separator className={`group flex shrink-0 items-center justify-center ${direction === 'row' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}`}>
      <div className={`rounded-full bg-fw-border-strong transition group-hover:bg-fw-accent dark:bg-fw-surface-raised dark:group-hover:bg-fw-accent ${direction === 'row' ? 'h-10 w-1' : 'h-1 w-10'}`} />
    </Separator>
  )
}

export default function WorkbenchLayout({ node, renderPane, onLayoutResize }: WorkbenchLayoutProps) {
  if (node.kind === 'pane') {
    return <>{renderPane(node.id)}</>
  }

  const defaultLayout: Layout = Object.fromEntries(node.children.map((child, index) => [child.id, node.sizes[index] || Math.floor(100 / Math.max(1, node.children.length))]))

  return (
    <Group
      orientation={node.direction === 'row' ? 'horizontal' : 'vertical'}
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout: Layout) => onLayoutResize(node.id, node.children.map((child) => Number(layout[child.id] || 0)))}
      className="h-full min-h-0 w-full min-w-0"
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          <Panel id={child.id} defaultSize={node.sizes[index] || undefined} minSize={15} className="min-h-0 min-w-0">
            <WorkbenchLayout node={child} renderPane={renderPane} onLayoutResize={onLayoutResize} />
          </Panel>
          {index < node.children.length - 1 && <ResizeHandle direction={node.direction} />}
        </Fragment>
      ))}
    </Group>
  )
}