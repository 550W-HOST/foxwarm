export type WorkbenchTabBase = {
  id: string
  title: string
}

export type WorkbenchTab =
  | (WorkbenchTabBase & { type: 'chat'; sessionId: string; preview?: boolean })
  | (WorkbenchTabBase & { type: 'terminal'; terminalId?: string; nodeId?: string; cwd?: string; contextSessionId?: string; createMode?: 'new' | 'reuse' })

export type WorkbenchPaneNode = {
  id: string
  kind: 'pane'
  tabIds: string[]
  activeTabId: string | null
}

export type WorkbenchSplitNode = {
  id: string
  kind: 'split'
  direction: 'row' | 'column'
  sizes: number[]
  children: WorkbenchLayoutNode[]
}

export type WorkbenchLayoutNode = WorkbenchPaneNode | WorkbenchSplitNode

export type WorkbenchPersistedState = {
  version: 4
  tabsById: Record<string, WorkbenchTab>
  root: WorkbenchLayoutNode
  focusedPaneId: string | null
}

export type WorkbenchDropTarget =
  | { type: 'tab'; paneId: string; tabId: string }
  | { type: 'pane-center'; paneId: string }
  | { type: 'pane-edge'; paneId: string; edge: 'left' | 'right' | 'top' | 'bottom' }