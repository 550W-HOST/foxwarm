import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { WorkbenchLayoutNode, WorkbenchPaneNode, WorkbenchPersistedState, WorkbenchTab } from './types'
import {
  createPaneNode,
  createWorkbenchId,
  findPaneContainingTab,
  findPaneNode,
  getPaneIds,
  mapLayoutTree,
  normalizePersistedWorkbenchState,
  normalizeRecentIds,
  removePaneFromLayout,
  replacePaneWithSplit,
} from './utils'

const WORKBENCH_STATE_STORAGE_KEY = 'foxwarm_workbench_state_v4'
const LEGACY_TABS_STORAGE_KEY = 'foxwarm_workbench_tabs_v3'
const LEGACY_ACTIVE_TAB_STORAGE_KEY = 'foxwarm_last_active_tab_v1'

function readJsonStorageItem<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function loadLegacyWorkbenchState(): WorkbenchPersistedState {
  const legacyTabs = readJsonStorageItem<WorkbenchTab[]>(LEGACY_TABS_STORAGE_KEY) || []
  const tabMap = Object.fromEntries(legacyTabs.map((tab) => [tab.id, tab]))
  const legacyActiveTabId = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_ACTIVE_TAB_STORAGE_KEY) : null
  const root = createPaneNode(legacyTabs.map((tab) => tab.id), legacyActiveTabId || legacyTabs[0]?.id || null)
  return normalizePersistedWorkbenchState({
    version: 4,
    tabsById: tabMap,
    root,
    focusedPaneId: root.id,
  })
}

function getDefaultWorkbenchState(): WorkbenchPersistedState {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    const root = createPaneNode()
    return {
      version: 4,
      tabsById: {},
      root,
      focusedPaneId: root.id,
      recentPaneIds: [root.id],
    }
  }

  return loadLegacyWorkbenchState()
}

export type WorkbenchStoreState = WorkbenchPersistedState & {
  focusPane: (paneId: string) => void
  setPaneCollapsed: (paneId: string, collapsed: boolean) => void
  activateTab: (tabId: string, options?: { expandPane?: boolean }) => void
  setPaneActiveTab: (paneId: string, tabId: string | null, options?: { expandPane?: boolean }) => void
  upsertTab: (tab: WorkbenchTab, options?: { paneId?: string; activate?: boolean; index?: number }) => void
  updateTab: (tabId: string, updater: (tab: WorkbenchTab) => WorkbenchTab) => void
  removeTab: (tabId: string) => void
  replaceTabId: (oldTabId: string, tab: WorkbenchTab) => void
  reorderTabs: (paneId: string, activeTabId: string, overTabId: string) => void
  moveTabToPane: (tabId: string, targetPaneId: string, options?: { beforeTabId?: string | null; activate?: boolean }) => void
  splitPaneWithTab: (sourcePaneId: string, tabId: string, edge: 'left' | 'right' | 'top' | 'bottom') => string | null
  splitPaneWithNewTab: (sourcePaneId: string, tab: WorkbenchTab, edge: 'left' | 'right' | 'top' | 'bottom', sizes?: [number, number]) => string | null
  dockTabToPaneEdge: (tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom', sizes?: [number, number]) => string | null
  movePaneToEdge: (sourcePaneId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') => void
  closePane: (paneId: string) => void
  updateSplitSizes: (splitId: string, sizes: number[]) => void
  reconcileTabs: (updater: (tabsById: Record<string, WorkbenchTab>, root: WorkbenchLayoutNode) => { tabsById: Record<string, WorkbenchTab>; root: WorkbenchLayoutNode }) => void
}

function insertIntoArray<T>(items: T[], value: T, index?: number): T[] {
  const next = [...items]
  if (typeof index === 'number' && index >= 0 && index <= next.length) {
    next.splice(index, 0, value)
    return next
  }
  next.push(value)
  return next
}

function removeFromArray<T>(items: T[], predicate: (item: T) => boolean): { next: T[]; removedIndex: number } {
  const index = items.findIndex(predicate)
  if (index < 0) return { next: [...items], removedIndex: -1 }
  const next = [...items]
  next.splice(index, 1)
  return { next, removedIndex: index }
}

function recordRecentTabIds(
  pane: WorkbenchPaneNode,
  nextActiveTabId: string | null,
  validTabIds: readonly string[],
): string[] {
  const candidates = [
    ...(nextActiveTabId ? [nextActiveTabId] : []),
    ...(pane.activeTabId ? [pane.activeTabId] : []),
    ...(pane.recentTabIds || []),
  ]
  return normalizeRecentIds(candidates, nextActiveTabId, validTabIds)
}

function recordRecentPaneIds(
  previousRecent: readonly string[] | undefined,
  previousFocusedPaneId: string | null,
  nextFocusedPaneId: string | null,
  validPaneIds: readonly string[],
): string[] {
  const candidates = [
    ...(nextFocusedPaneId ? [nextFocusedPaneId] : []),
    ...(previousFocusedPaneId ? [previousFocusedPaneId] : []),
    ...(previousRecent || []),
  ]
  return normalizeRecentIds(candidates, nextFocusedPaneId, validPaneIds)
}

function selectFocusedPaneAfterRemoval(
  previousFocusedPaneId: string | null,
  previousRecent: readonly string[] | undefined,
  nextPaneIds: readonly string[],
): string | null {
  if (previousFocusedPaneId && nextPaneIds.includes(previousFocusedPaneId)) {
    return previousFocusedPaneId
  }
  const previousSurviving = Array.isArray(previousRecent)
    ? previousRecent.find((id) => nextPaneIds.includes(id))
    : undefined
  return previousSurviving || nextPaneIds[0] || null
}

function getPaneAfterTabRemoval(pane: WorkbenchPaneNode, tabId: string): WorkbenchPaneNode {
  const { next, removedIndex } = removeFromArray(pane.tabIds, (currentId) => currentId === tabId)
  const remainingRecent = (pane.recentTabIds || []).filter((id) => id !== tabId && next.includes(id))
  const neighborFallback = next[Math.min(Math.max(removedIndex, 0), Math.max(0, next.length - 1))] || next[0] || null
  const nextActiveTabId = pane.activeTabId && pane.activeTabId !== tabId && next.includes(pane.activeTabId)
    ? pane.activeTabId
    : (remainingRecent[0] || neighborFallback)
  return {
    ...pane,
    tabIds: next,
    activeTabId: nextActiveTabId,
    recentTabIds: normalizeRecentIds(remainingRecent, nextActiveTabId, next),
  }
}

function getInsertedPane(pane: WorkbenchPaneNode, tabId: string, options?: { beforeTabId?: string | null; activate?: boolean }): WorkbenchPaneNode {
  const withoutDuplicates = pane.tabIds.filter((currentId) => currentId !== tabId)
  let insertIndex = withoutDuplicates.length

  if (options?.beforeTabId) {
    const targetIndex = withoutDuplicates.indexOf(options.beforeTabId)
    if (targetIndex >= 0) {
      insertIndex = targetIndex
    }
  }

  const tabIds = insertIntoArray(withoutDuplicates, tabId, insertIndex)
  const shouldActivate = options?.activate !== false
  const nextActiveTabId = shouldActivate
    ? tabId
    : (pane.activeTabId && tabIds.includes(pane.activeTabId) ? pane.activeTabId : (tabIds[0] || null))
  return {
    ...pane,
    tabIds,
    collapsed: shouldActivate ? false : pane.collapsed,
    activeTabId: nextActiveTabId,
    recentTabIds: shouldActivate
      ? recordRecentTabIds(pane, nextActiveTabId, tabIds)
      : normalizeRecentIds(pane.recentTabIds, nextActiveTabId, tabIds),
  }
}

const initialState = getDefaultWorkbenchState()

export const useWorkbenchStore = create<WorkbenchStoreState>()(persist((set) => ({
  ...initialState,

  focusPane: (paneId) => {
    set((state) => {
      const pane = findPaneNode(state.root, paneId)
      if (!pane) return state
      const paneIds = getPaneIds(state.root)
      return {
        focusedPaneId: pane.id,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, pane.id, paneIds),
      }
    })
  },

  setPaneCollapsed: (paneId, collapsed) => {
    set((state) => {
      const pane = findPaneNode(state.root, paneId)
      if (!pane || pane.collapsed === collapsed) return state
      return {
        root: mapLayoutTree(state.root, (node) => {
          if (node.kind !== 'pane' || node.id !== paneId) return node
          return { ...node, collapsed }
        }),
      }
    })
  },

  activateTab: (tabId, options) => {
    set((state) => {
      const pane = findPaneContainingTab(state.root, tabId)
      if (!pane) return state

      const nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== pane.id) return node
        return {
          ...node,
          activeTabId: tabId,
          collapsed: options?.expandPane === false ? node.collapsed : false,
          recentTabIds: recordRecentTabIds(node, tabId, node.tabIds),
        }
      })
      return {
        root: nextRoot,
        focusedPaneId: pane.id,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, pane.id, getPaneIds(nextRoot)),
      }
    })
  },

  setPaneActiveTab: (paneId, tabId, options) => {
    set((state) => {
      const nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== paneId) return node
        const nextActiveTabId = tabId && node.tabIds.includes(tabId) ? tabId : (node.tabIds[0] || null)
        return {
          ...node,
          activeTabId: nextActiveTabId,
          collapsed: options?.expandPane === false || !tabId || !node.tabIds.includes(tabId) ? node.collapsed : false,
          recentTabIds: recordRecentTabIds(node, nextActiveTabId, node.tabIds),
        }
      })
      return {
        root: nextRoot,
        focusedPaneId: paneId,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, paneId, getPaneIds(nextRoot)),
      }
    })
  },

  upsertTab: (tab, options) => {
    set((state) => {
      const existingPane = findPaneContainingTab(state.root, tab.id)
      const targetPaneId = options?.paneId || existingPane?.id || state.focusedPaneId || getPaneIds(state.root)[0] || null
      if (!targetPaneId) return state

      const activate = options?.activate !== false
      const nextTabsById = {
        ...state.tabsById,
        [tab.id]: tab,
      }

      const nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== targetPaneId) return node
        return getInsertedPane(node, tab.id, { activate, beforeTabId: null })
      })
      const nextFocusedPaneId = activate ? targetPaneId : state.focusedPaneId
      return {
        tabsById: nextTabsById,
        root: nextRoot,
        focusedPaneId: nextFocusedPaneId,
        recentPaneIds: activate
          ? recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextFocusedPaneId, getPaneIds(nextRoot))
          : normalizeRecentIds(state.recentPaneIds, nextFocusedPaneId, getPaneIds(nextRoot)),
      }
    })
  },

  updateTab: (tabId, updater) => {
    set((state) => {
      const currentTab = state.tabsById[tabId]
      if (!currentTab) return state
      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: updater(currentTab),
        },
      }
    })
  },

  removeTab: (tabId) => {
    set((state) => {
      const pane = findPaneContainingTab(state.root, tabId)
      if (!pane) return state

      let nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== pane.id) return node
        return getPaneAfterTabRemoval(node, tabId)
      })

      const updatedPane = findPaneNode(nextRoot, pane.id)
      if (updatedPane && updatedPane.tabIds.length === 0 && getPaneIds(nextRoot).length > 1) {
        nextRoot = removePaneFromLayout(nextRoot, pane.id).node
      }

      const nextPaneIds = getPaneIds(nextRoot)
      const focusedPaneId = selectFocusedPaneAfterRemoval(state.focusedPaneId, state.recentPaneIds, nextPaneIds)

      const nextTabsById = { ...state.tabsById }
      delete nextTabsById[tabId]

      return {
        tabsById: nextTabsById,
        root: nextRoot,
        focusedPaneId,
        recentPaneIds: normalizeRecentIds(state.recentPaneIds, focusedPaneId, nextPaneIds),
      }
    })
  },

  replaceTabId: (oldTabId, tab) => {
    set((state) => {
      const pane = findPaneContainingTab(state.root, oldTabId)
      // Keep the replaced tab's position. Retained tab content renders in this order, and
      // moving a mounted host in the DOM resets its scroll positions and reloads iframes.
      const nextTabsById: Record<string, WorkbenchTab> = {}
      for (const [id, current] of Object.entries(state.tabsById)) {
        if (id === oldTabId) nextTabsById[tab.id] = tab
        else if (id !== tab.id) nextTabsById[id] = current
      }
      if (!(oldTabId in state.tabsById)) nextTabsById[tab.id] = tab

      const nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || !node.tabIds.includes(oldTabId)) return node
        const tabIds = node.tabIds.map((currentId) => currentId === oldTabId ? tab.id : currentId)
        const nextActiveTabId = node.activeTabId === oldTabId ? tab.id : node.activeTabId
        const mappedRecent = (node.recentTabIds || (node.activeTabId ? [node.activeTabId] : []))
          .map((currentId) => currentId === oldTabId ? tab.id : currentId)
        return {
          ...node,
          tabIds,
          activeTabId: nextActiveTabId,
          recentTabIds: normalizeRecentIds(mappedRecent, nextActiveTabId, tabIds),
        }
      })
      const nextFocusedPaneId = pane?.id || state.focusedPaneId
      return {
        tabsById: nextTabsById,
        root: nextRoot,
        focusedPaneId: nextFocusedPaneId,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextFocusedPaneId, getPaneIds(nextRoot)),
      }
    })
  },

  reorderTabs: (paneId, activeTabId, overTabId) => {
    if (activeTabId === overTabId) return

    set((state) => ({
      root: mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== paneId) return node
        const currentIndex = node.tabIds.indexOf(activeTabId)
        const targetIndex = node.tabIds.indexOf(overTabId)
        if (currentIndex < 0 || targetIndex < 0) return node
        const nextTabIds = [...node.tabIds]
        nextTabIds.splice(currentIndex, 1)
        nextTabIds.splice(targetIndex, 0, activeTabId)
        return {
          ...node,
          tabIds: nextTabIds,
        }
      }),
    }))
  },

  moveTabToPane: (tabId, targetPaneId, options) => {
    set((state) => {
      const sourcePane = findPaneContainingTab(state.root, tabId)
      const targetPane = findPaneNode(state.root, targetPaneId)
      if (!sourcePane || !targetPane) return state

      if (sourcePane.id === targetPaneId) {
        const nextRoot = mapLayoutTree(state.root, (node) => {
          if (node.kind !== 'pane' || node.id !== sourcePane.id) return node
          return getInsertedPane(getPaneAfterTabRemoval(node, tabId), tabId, options)
        })
        const nextFocusedPaneId = options?.activate === false ? state.focusedPaneId : targetPaneId
        return {
          root: nextRoot,
          focusedPaneId: nextFocusedPaneId,
          recentPaneIds: options?.activate === false
            ? normalizeRecentIds(state.recentPaneIds, nextFocusedPaneId, getPaneIds(nextRoot))
            : recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextFocusedPaneId, getPaneIds(nextRoot)),
        }
      }

      let nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane') return node
        if (node.id === sourcePane.id) {
          return getPaneAfterTabRemoval(node, tabId)
        }
        if (node.id === targetPaneId) {
          return getInsertedPane(node, tabId, options)
        }
        return node
      })

      const updatedSourcePane = findPaneNode(nextRoot, sourcePane.id)
      if (updatedSourcePane && updatedSourcePane.tabIds.length === 0 && getPaneIds(nextRoot).length > 1) {
        nextRoot = removePaneFromLayout(nextRoot, sourcePane.id).node
      }

      const nextPaneIds = getPaneIds(nextRoot)
      const nextFocusedPaneId = options?.activate === false
        ? selectFocusedPaneAfterRemoval(state.focusedPaneId, state.recentPaneIds, nextPaneIds)
        : targetPaneId
      return {
        root: nextRoot,
        focusedPaneId: nextFocusedPaneId,
        recentPaneIds: options?.activate === false
          ? normalizeRecentIds(state.recentPaneIds, nextFocusedPaneId, nextPaneIds)
          : recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextFocusedPaneId, nextPaneIds),
      }
    })
  },

  splitPaneWithTab: (sourcePaneId, tabId, edge) => {
    const nextPaneId = createWorkbenchId('pane')

    set((state) => {
      const sourcePane = findPaneNode(state.root, sourcePaneId)
      if (!sourcePane) return state

      const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
      const position = edge === 'left' || edge === 'top' ? 'before' : 'after'
      const nextPane = createPaneNode([tabId], tabId, nextPaneId)
      const rootWithoutTab = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== sourcePaneId) return node
        return getPaneAfterTabRemoval(node, tabId)
      })
      const nextRoot = replacePaneWithSplit(rootWithoutTab, sourcePaneId, direction, nextPane, position)

      return {
        root: nextRoot,
        focusedPaneId: nextPaneId,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextPaneId, getPaneIds(nextRoot)),
      }
    })

    return nextPaneId
  },

  splitPaneWithNewTab: (sourcePaneId, tab, edge, sizes) => {
    const nextPaneId = createWorkbenchId('pane')

    set((state) => {
      const sourcePane = findPaneNode(state.root, sourcePaneId)
      if (!sourcePane) return state

      const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
      const position = edge === 'left' || edge === 'top' ? 'before' : 'after'
      const nextPane = createPaneNode([tab.id], tab.id, nextPaneId)
      const nextRoot = replacePaneWithSplit(state.root, sourcePaneId, direction, nextPane, position, sizes)

      return {
        tabsById: {
          ...state.tabsById,
          [tab.id]: tab,
        },
        root: nextRoot,
        focusedPaneId: nextPaneId,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextPaneId, getPaneIds(nextRoot)),
      }
    })

    return nextPaneId
  },

  dockTabToPaneEdge: (tabId, targetPaneId, edge, sizes) => {
    const nextPaneId = createWorkbenchId('pane')

    set((state) => {
      const sourcePane = findPaneContainingTab(state.root, tabId)
      const targetPane = findPaneNode(state.root, targetPaneId)
      if (!sourcePane || !targetPane) return state

      const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
      const position = edge === 'left' || edge === 'top' ? 'before' : 'after'
      const nextPane = createPaneNode([tabId], tabId, nextPaneId)

      let nextRoot = mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== sourcePane.id) return node
        return getPaneAfterTabRemoval(node, tabId)
      })

      nextRoot = replacePaneWithSplit(nextRoot, targetPaneId, direction, nextPane, position, sizes)

      const updatedSourcePane = findPaneNode(nextRoot, sourcePane.id)
      if (updatedSourcePane && updatedSourcePane.tabIds.length === 0 && getPaneIds(nextRoot).length > 1) {
        nextRoot = removePaneFromLayout(nextRoot, sourcePane.id).node
      }

      return {
        root: nextRoot,
        focusedPaneId: nextPaneId,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, nextPaneId, getPaneIds(nextRoot)),
      }
    })

    return nextPaneId
  },

  movePaneToEdge: (sourcePaneId, targetPaneId, edge) => {
    if (sourcePaneId === targetPaneId) return

    set((state) => {
      const sourcePane = findPaneNode(state.root, sourcePaneId)
      if (!sourcePane || !findPaneNode(state.root, targetPaneId)) return state

      const result = removePaneFromLayout(state.root, sourcePaneId)
      if (!result.removed || !findPaneNode(result.node, targetPaneId)) return state

      const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
      const position = edge === 'left' || edge === 'top' ? 'before' : 'after'
      const nextRoot = replacePaneWithSplit(result.node, targetPaneId, direction, sourcePane, position)
      return {
        root: nextRoot,
        focusedPaneId: sourcePaneId,
        recentPaneIds: recordRecentPaneIds(state.recentPaneIds, state.focusedPaneId, sourcePaneId, getPaneIds(nextRoot)),
      }
    })
  },

  closePane: (paneId) => {
    set((state) => {
      const pane = findPaneNode(state.root, paneId)
      if (!pane) return state

      const tabIdsToRemove = new Set(pane.tabIds)
      const nextTabsById = Object.fromEntries(Object.entries(state.tabsById).filter(([tabId]) => !tabIdsToRemove.has(tabId)))
      const nextRoot = removePaneFromLayout(state.root, paneId).node
      const nextPaneIds = getPaneIds(nextRoot)
      const focusedPaneId = selectFocusedPaneAfterRemoval(state.focusedPaneId, state.recentPaneIds, nextPaneIds)

      return {
        tabsById: nextTabsById,
        root: nextRoot,
        focusedPaneId,
        recentPaneIds: normalizeRecentIds(state.recentPaneIds, focusedPaneId, nextPaneIds),
      }
    })
  },

  updateSplitSizes: (splitId, sizes) => {
    set((state) => ({
      root: mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'split' || node.id !== splitId) return node
        if (node.children.some((child) => child.kind === 'pane' && child.collapsed)) return node
        return {
          ...node,
          sizes: sizes.map((size) => Math.max(1, Number(size) || 1)),
        }
      }),
    }))
  },

  reconcileTabs: (updater) => {
    set((state) => normalizePersistedWorkbenchState({
      ...state,
      ...updater(state.tabsById, state.root),
    }))
  },
}), {
  name: WORKBENCH_STATE_STORAGE_KEY,
  version: 1,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    version: 4,
    tabsById: state.tabsById,
    root: state.root,
    focusedPaneId: state.focusedPaneId,
    recentPaneIds: state.recentPaneIds,
  }),
  merge: (persistedState, currentState) => {
    if (!persistedState || typeof persistedState !== 'object') {
      return currentState
    }

    return {
      ...currentState,
      ...normalizePersistedWorkbenchState(persistedState as WorkbenchPersistedState),
    }
  },
}))

export function getWorkbenchTabById(tabId: string): WorkbenchTab | null {
  return useWorkbenchStore.getState().tabsById[tabId] || null
}