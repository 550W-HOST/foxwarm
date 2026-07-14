import type { WorkbenchLayoutNode, WorkbenchPaneNode, WorkbenchPersistedState, WorkbenchSplitNode, WorkbenchTab } from './types'

const DEFAULT_SPLIT_SIZES = [50, 50]

export function createWorkbenchId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function createPaneNode(tabIds: string[] = [], activeTabId: string | null = tabIds[0] || null, id: string = createWorkbenchId('pane')): WorkbenchPaneNode {
  return {
    id,
    kind: 'pane',
    tabIds: [...tabIds],
    activeTabId: activeTabId && tabIds.includes(activeTabId) ? activeTabId : (tabIds[0] || null),
  }
}

export function createSplitNode(direction: 'row' | 'column', children: WorkbenchLayoutNode[], sizes?: number[], id: string = createWorkbenchId('split')): WorkbenchSplitNode {
  const resolvedSizes = Array.isArray(sizes) && sizes.length === children.length
    ? sizes.map((size) => Math.max(1, Number(size) || 1))
    : Array.from({ length: children.length }, () => Math.floor(100 / Math.max(1, children.length)))

  return {
    id,
    kind: 'split',
    direction,
    sizes: resolvedSizes,
    children,
  }
}

export function isPaneNode(node: WorkbenchLayoutNode): node is WorkbenchPaneNode {
  return node.kind === 'pane'
}

export function isSplitNode(node: WorkbenchLayoutNode): node is WorkbenchSplitNode {
  return node.kind === 'split'
}

export function getPaneIds(node: WorkbenchLayoutNode): string[] {
  if (isPaneNode(node)) return [node.id]
  return node.children.flatMap(getPaneIds)
}

export function getPaneNodes(node: WorkbenchLayoutNode): WorkbenchPaneNode[] {
  if (isPaneNode(node)) return [node]
  return node.children.flatMap(getPaneNodes)
}

export function getFlattenedTabIds(node: WorkbenchLayoutNode): string[] {
  return getPaneNodes(node).flatMap((pane) => pane.tabIds)
}

export function findPaneNode(node: WorkbenchLayoutNode, paneId: string): WorkbenchPaneNode | null {
  if (isPaneNode(node)) {
    return node.id === paneId ? node : null
  }
  for (const child of node.children) {
    const found = findPaneNode(child, paneId)
    if (found) return found
  }
  return null
}

export function findPaneContainingTab(node: WorkbenchLayoutNode, tabId: string): WorkbenchPaneNode | null {
  if (isPaneNode(node)) {
    return node.tabIds.includes(tabId) ? node : null
  }
  for (const child of node.children) {
    const found = findPaneContainingTab(child, tabId)
    if (found) return found
  }
  return null
}

function findFirstPane(node: WorkbenchLayoutNode): WorkbenchPaneNode | null {
  if (isPaneNode(node)) {
    return node
  }

  for (const child of node.children) {
    const found = findFirstPane(child)
    if (found) return found
  }

  return null
}

function findPanePath(node: WorkbenchLayoutNode, paneId: string, path: Array<{ split: WorkbenchSplitNode; childIndex: number }> = []): Array<{ split: WorkbenchSplitNode; childIndex: number }> | null {
  if (isPaneNode(node)) {
    return node.id === paneId ? path : null
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    const found = findPanePath(child, paneId, [...path, { split: node, childIndex: index }])
    if (found) return found
  }

  return null
}

export function findPaneBelow(node: WorkbenchLayoutNode, paneId: string): WorkbenchPaneNode | null {
  const path = findPanePath(node, paneId)
  if (!path) return null

  for (let index = path.length - 1; index >= 0; index -= 1) {
    const step = path[index]
    if (step.split.direction !== 'column') continue
    if (step.childIndex >= step.split.children.length - 1) continue

    const siblingBelow = step.split.children[step.childIndex + 1]
    return findFirstPane(siblingBelow)
  }

  return null
}

export function mapLayoutTree(node: WorkbenchLayoutNode, updater: (node: WorkbenchLayoutNode) => WorkbenchLayoutNode): WorkbenchLayoutNode {
  const nextNode = isSplitNode(node)
    ? updater({
        ...node,
        children: node.children.map((child) => mapLayoutTree(child, updater)),
      })
    : updater(node)

  return normalizeLayoutNode(nextNode)
}

export function normalizeLayoutNode(node: WorkbenchLayoutNode): WorkbenchLayoutNode {
  if (isPaneNode(node)) {
    const uniqueTabIds = Array.from(new Set(node.tabIds))
    return {
      ...node,
      tabIds: uniqueTabIds,
      activeTabId: node.activeTabId && uniqueTabIds.includes(node.activeTabId)
        ? node.activeTabId
        : (uniqueTabIds[0] || null),
    }
  }

  const normalizedChildren = node.children.map(normalizeLayoutNode)
  if (normalizedChildren.length === 1) {
    return normalizedChildren[0]
  }

  const normalizedSizes = node.sizes.length === normalizedChildren.length
    ? node.sizes.map((size) => Math.max(1, Number(size) || 1))
    : DEFAULT_SPLIT_SIZES.slice(0, normalizedChildren.length)

  return {
    ...node,
    children: normalizedChildren,
    sizes: normalizedSizes,
  }
}

type RemovePaneResult = {
  node: WorkbenchLayoutNode
  removed: boolean
}

export function removePaneFromLayout(node: WorkbenchLayoutNode, paneId: string): RemovePaneResult {
  if (isPaneNode(node)) {
    return { node, removed: false }
  }

  let removed = false
  const nextChildren: WorkbenchLayoutNode[] = []
  const nextSizes: number[] = []

  node.children.forEach((child, index) => {
    if (isPaneNode(child) && child.id === paneId) {
      removed = true
      return
    }

    const result = removePaneFromLayout(child, paneId)
    removed = removed || result.removed
    nextChildren.push(result.node)
    nextSizes.push(node.sizes[index] ?? 1)
  })

  if (!removed) {
    return { node, removed: false }
  }

  if (nextChildren.length === 0) {
    return { node: createPaneNode(), removed: true }
  }

  if (nextChildren.length === 1) {
    return { node: normalizeLayoutNode(nextChildren[0]), removed: true }
  }

  return {
    node: normalizeLayoutNode({
      ...node,
      children: nextChildren,
      sizes: nextSizes,
    }),
    removed: true,
  }
}

export function replacePaneWithSplit(node: WorkbenchLayoutNode, paneId: string, direction: 'row' | 'column', newSibling: WorkbenchPaneNode, position: 'before' | 'after'): WorkbenchLayoutNode {
  if (isPaneNode(node)) {
    if (node.id !== paneId) return node
    const orderedChildren = position === 'before'
      ? [newSibling, node]
      : [node, newSibling]
    return createSplitNode(direction, orderedChildren, DEFAULT_SPLIT_SIZES)
  }

  return normalizeLayoutNode({
    ...node,
    children: node.children.map((child) => replacePaneWithSplit(child, paneId, direction, newSibling, position)),
  })
}

function isSupportedWorkbenchTab(tab: unknown): tab is WorkbenchTab {
  if (!tab || typeof tab !== 'object') return false
  const raw = tab as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return false

  if (raw.type === 'chat') {
    return typeof raw.sessionId === 'string' && raw.sessionId.length > 0
  }

  if (raw.type === 'terminal') {
    return true
  }

  if (raw.type === 'vscode' || raw.type === 'agents' || raw.type === 'setup') {
    return true
  }

  return false
}

function filterLayoutToValidTabs(node: WorkbenchLayoutNode, validTabIds: Set<string>): WorkbenchLayoutNode | null {
  if (isPaneNode(node)) {
    const tabIds = Array.from(new Set(node.tabIds.filter((tabId) => validTabIds.has(tabId))))
    if (tabIds.length === 0) {
      return null
    }
    return createPaneNode(tabIds, node.activeTabId && tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0], node.id)
  }

  const children: WorkbenchLayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const filteredChild = filterLayoutToValidTabs(child, validTabIds)
    if (!filteredChild) return
    children.push(filteredChild)
    sizes.push(node.sizes[index] ?? 1)
  })

  if (children.length === 0) {
    return null
  }
  if (children.length === 1) {
    return children[0]
  }

  return createSplitNode(node.direction, children, sizes, node.id)
}

export function sanitizeTabsById(tabsById: Record<string, WorkbenchTab>, root: WorkbenchLayoutNode): Record<string, WorkbenchTab> {
  const referencedIds = new Set<string>()
  const collect = (node: WorkbenchLayoutNode) => {
    if (isPaneNode(node)) {
      node.tabIds.forEach((tabId) => referencedIds.add(tabId))
      return
    }
    node.children.forEach(collect)
  }
  collect(root)

  return Object.fromEntries(Object.entries(tabsById).flatMap(([tabId, tab]) => {
    if (!referencedIds.has(tabId) || !isSupportedWorkbenchTab(tab)) return []

    // Older workbench state may contain the removed tab-level `pinned` flag.
    // Read it tolerantly, but strip it so all future persisted writes use the
    // current single-row tab model.
    const { pinned: _legacyPinned, ...sanitizedTab } = tab as WorkbenchTab & { pinned?: unknown }
    if (sanitizedTab.type === 'vscode') {
      return [[tabId, { ...sanitizedTab, title: 'Code' } as WorkbenchTab]]
    }
    return [[tabId, sanitizedTab as WorkbenchTab]]
  }))
}

export function normalizePersistedWorkbenchState(state: WorkbenchPersistedState): WorkbenchPersistedState {
  const originalRoot = normalizeLayoutNode(state.root)
  const tabsById = sanitizeTabsById(state.tabsById, originalRoot)
  const root = normalizeLayoutNode(filterLayoutToValidTabs(originalRoot, new Set(Object.keys(tabsById))) || createPaneNode())
  const paneIds = getPaneIds(root)
  return {
    version: 4,
    tabsById,
    root,
    focusedPaneId: state.focusedPaneId && paneIds.includes(state.focusedPaneId)
      ? state.focusedPaneId
      : (paneIds[0] || null),
  }
}