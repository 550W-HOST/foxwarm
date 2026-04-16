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
    }
  }

  return loadLegacyWorkbenchState()
}

export type WorkbenchStoreState = WorkbenchPersistedState & {
  focusPane: (paneId: string) => void
  activateTab: (tabId: string) => void
  setPaneActiveTab: (paneId: string, tabId: string | null) => void
  upsertTab: (tab: WorkbenchTab, options?: { paneId?: string; activate?: boolean; index?: number }) => void
  updateTab: (tabId: string, updater: (tab: WorkbenchTab) => WorkbenchTab) => void
  removeTab: (tabId: string) => void
  replaceTabId: (oldTabId: string, tab: WorkbenchTab) => void
  reorderTabs: (paneId: string, activeTabId: string, overTabId: string) => void
  moveTabToPane: (tabId: string, targetPaneId: string, options?: { beforeTabId?: string | null; activate?: boolean }) => void
  splitPaneWithTab: (sourcePaneId: string, tabId: string, edge: 'left' | 'right' | 'top' | 'bottom') => string | null
  dockTabToPaneEdge: (tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') => string | null
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

function getPaneAfterTabRemoval(pane: WorkbenchPaneNode, tabId: string): WorkbenchPaneNode {
  const { next, removedIndex } = removeFromArray(pane.tabIds, (currentId) => currentId === tabId)
  const fallbackActive = next[Math.min(Math.max(removedIndex, 0), Math.max(0, next.length - 1))] || next[0] || null
  return {
    ...pane,
    tabIds: next,
    activeTabId: pane.activeTabId === tabId ? fallbackActive : (pane.activeTabId && next.includes(pane.activeTabId) ? pane.activeTabId : fallbackActive),
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
  return {
    ...pane,
    tabIds,
    activeTabId: options?.activate === false ? (pane.activeTabId && tabIds.includes(pane.activeTabId) ? pane.activeTabId : (tabIds[0] || null)) : tabId,
  }
}

const initialState = getDefaultWorkbenchState()

export const useWorkbenchStore = create<WorkbenchStoreState>()(persist((set) => ({
  ...initialState,

  focusPane: (paneId) => {
    set((state) => {
      const pane = findPaneNode(state.root, paneId)
      if (!pane) return state
      return {
        focusedPaneId: pane.id,
      }
    })
  },

  activateTab: (tabId) => {
    set((state) => {
      const pane = findPaneContainingTab(state.root, tabId)
      if (!pane) return state

      return {
        root: mapLayoutTree(state.root, (node) => {
          if (node.kind !== 'pane' || node.id !== pane.id) return node
          return {
            ...node,
            activeTabId: tabId,
          }
        }),
        focusedPaneId: pane.id,
      }
    })
  },

  setPaneActiveTab: (paneId, tabId) => {
    set((state) => ({
      root: mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'pane' || node.id !== paneId) return node
        return {
          ...node,
          activeTabId: tabId && node.tabIds.includes(tabId) ? tabId : (node.tabIds[0] || null),
        }
      }),
      focusedPaneId: paneId,
    }))
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

      return {
        tabsById: nextTabsById,
        root: mapLayoutTree(state.root, (node) => {
          if (node.kind !== 'pane' || node.id !== targetPaneId) return node
          return getInsertedPane(node, tab.id, { activate, beforeTabId: null })
        }),
        focusedPaneId: activate ? targetPaneId : state.focusedPaneId,
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
      const focusedPaneId = state.focusedPaneId && nextPaneIds.includes(state.focusedPaneId)
        ? state.focusedPaneId
        : (nextPaneIds[0] || null)

      const nextTabsById = { ...state.tabsById }
      delete nextTabsById[tabId]

      return {
        tabsById: nextTabsById,
        root: nextRoot,
        focusedPaneId,
      }
    })
  },

  replaceTabId: (oldTabId, tab) => {
    set((state) => {
      const pane = findPaneContainingTab(state.root, oldTabId)
      const nextTabsById = { ...state.tabsById }
      delete nextTabsById[oldTabId]
      nextTabsById[tab.id] = tab

      return {
        tabsById: nextTabsById,
        root: mapLayoutTree(state.root, (node) => {
          if (node.kind !== 'pane' || !node.tabIds.includes(oldTabId)) return node
          const tabIds = node.tabIds.map((currentId) => currentId === oldTabId ? tab.id : currentId)
          return {
            ...node,
            tabIds,
            activeTabId: node.activeTabId === oldTabId ? tab.id : node.activeTabId,
          }
        }),
        focusedPaneId: pane?.id || state.focusedPaneId,
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

      return {
        root: nextRoot,
        focusedPaneId: options?.activate === false ? state.focusedPaneId : targetPaneId,
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
      }
    })

    return nextPaneId
  },

  dockTabToPaneEdge: (tabId, targetPaneId, edge) => {
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

      nextRoot = replacePaneWithSplit(nextRoot, targetPaneId, direction, nextPane, position)

      const updatedSourcePane = findPaneNode(nextRoot, sourcePane.id)
      if (updatedSourcePane && updatedSourcePane.tabIds.length === 0 && getPaneIds(nextRoot).length > 1) {
        nextRoot = removePaneFromLayout(nextRoot, sourcePane.id).node
      }

      return {
        root: nextRoot,
        focusedPaneId: nextPaneId,
      }
    })

    return nextPaneId
  },

  closePane: (paneId) => {
    set((state) => {
      const pane = findPaneNode(state.root, paneId)
      if (!pane) return state

      const tabIdsToRemove = new Set(pane.tabIds)
      const nextTabsById = Object.fromEntries(Object.entries(state.tabsById).filter(([tabId]) => !tabIdsToRemove.has(tabId)))
      const nextRoot = removePaneFromLayout(state.root, paneId).node
      const nextPaneIds = getPaneIds(nextRoot)

      return {
        tabsById: nextTabsById,
        root: nextRoot,
        focusedPaneId: state.focusedPaneId && nextPaneIds.includes(state.focusedPaneId)
          ? state.focusedPaneId
          : (nextPaneIds[0] || null),
      }
    })
  },

  updateSplitSizes: (splitId, sizes) => {
    set((state) => ({
      root: mapLayoutTree(state.root, (node) => {
        if (node.kind !== 'split' || node.id !== splitId) return node
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