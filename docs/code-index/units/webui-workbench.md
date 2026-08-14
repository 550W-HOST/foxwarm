# Unit: webui-workbench

Files: packages/webui/src/components/WorkbenchLayout.tsx, packages/webui/src/components/WorkbenchPane.tsx, packages/webui/src/components/WorkbenchTabs.tsx, packages/webui/src/workbench/store.ts, packages/webui/src/workbench/types.ts, packages/webui/src/workbench/utils.ts, packages/webui/test/sessionListAndWorkbenchState.test.mjs, packages/webui/test/systemTabs.e2e.mjs

## Purpose

Manages a multi-pane workbench UI with tabbed panels, drag-and-drop tab reordering/moving, resizable split layouts, and persistent state. Provides the layout tree structure, tab management store, and rendering components for a VS Code-style tabbed shell.

## Key Exports

- `WorkbenchLayout` — recursive component rendering split/pane layout tree with resizable panels
- `WorkbenchPane` — single pane component with tab bar, drop zones, and toolbar controls
- `WorkbenchTabs` — single-row sortable tab strip with context menu
- `useWorkbenchStore` — Zustand store with all workbench state and actions
- `getWorkbenchTabById` — standalone accessor for a tab by ID
- `WorkbenchTab`, `WorkbenchLayoutNode`, `WorkbenchPaneNode`, `WorkbenchSplitNode`, `WorkbenchPersistedState`, `WorkbenchDropTarget` — core types, including `chat`, `terminal`, `vscode`, `agents`, and `setup` tab records
- `createPaneNode`, `createSplitNode`, `createWorkbenchId`, `findPaneNode`, `findPaneContainingTab`, `getPaneIds`, `getPaneNodes`, `getFlattenedTabIds`, `mapLayoutTree`, `removePaneFromLayout`, `replacePaneWithSplit`, `normalizePersistedWorkbenchState`, `findPaneBelow` — layout tree utilities

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `ResizeHandle({ direction })` | ~16–19 | Renders styled separator handle for resizable panels |
| `WorkbenchLayout({ node, renderPane, onLayoutResize })` | ~21–42 | Recursively renders layout tree as resizable panel groups |
| `PaneDropZone({ id, className, activeClassName, data })` | ~34–38 | Droppable zone overlay for drag-and-drop targeting |
| `ToolbarButton({ title, disabled, onClick, children })` | ~40–50 | Styled icon button for pane toolbar actions |
| `WorkbenchPane(props)` | ~55–130 | Full pane component with tabs, content, drop zones, and toolbar |
| `TabIcon({ type })` | ~38–42 | Returns icon component based on tab type |
| `isHorizontallyFullyVisible(element, container)` | ~44–49 | Checks if element is fully visible within container bounds |
| `getNormalizedWheelDelta(event, container)` | ~51–60 | Normalizes wheel event delta across delta modes |
| `copyTextToClipboard(text)` | ~62–78 | Copies text to clipboard with fallback to execCommand |
| `getTabCopyId(tab)` | ~80–83 | Returns copyable identifier for a tab |
| `getTabCopyPath(tab)` | ~85–90 | Returns copyable cwd for terminal tabs |
| `TabStripRow(props)` | ~92–165 | Renders the pane's single row of sortable tabs |
| `SortableTab(props)` | ~167–230 | Individual draggable/sortable tab element with interactions |
| `WorkbenchTabs(props)` | ~main export | Full single-row tab bar with context menu and toolbar |
| `readJsonStorageItem(key)` | ~16–22 | Safely reads and parses JSON from localStorage |
| `loadLegacyWorkbenchState()` | ~24–34 | Migrates legacy v3 tab storage to v4 layout format |
| `getDefaultWorkbenchState()` | ~36–48 | Returns initial state, migrating legacy data if present |
| `insertIntoArray(items, value, index)` | ~75–81 | Immutably inserts value at index in array |
| `removeFromArray(items, predicate)` | ~83–89 | Immutably removes first matching item, returns removed index |
| `getPaneAfterTabRemoval(pane, tabId)` | ~91–100 | Computes pane state after removing a tab with fallback active |
| `getInsertedPane(pane, tabId, options)` | ~102–118 | Computes pane state after inserting a tab at position |
| `createWorkbenchId(prefix)` | ~5–10 | Generates unique ID with crypto.randomUUID or fallback |
| `createPaneNode(tabIds, activeTabId, id)` | ~12–20 | Creates a new pane layout node |
| `createSplitNode(direction, children, sizes, id)` | ~22–35 | Creates a new split layout node with normalized sizes |
| `isPaneNode(node)` | ~37 | Type guard for pane nodes |
| `isSplitNode(node)` | ~41 | Type guard for split nodes |
| `getPaneIds(node)` | ~45–47 | Collects all pane IDs from layout tree |
| `getPaneNodes(node)` | ~49–51 | Collects all pane nodes from layout tree |
| `getFlattenedTabIds(node)` | ~53–55 | Gets all tab IDs across all panes |
| `findPaneNode(node, paneId)` | ~57–64 | Finds a pane node by ID in the tree |
| `findPaneContainingTab(node, tabId)` | ~66–73 | Finds the pane containing a specific tab |
| `findFirstPane(node)` | ~75–84 | Returns the first pane in depth-first order |
| `findPanePath(node, paneId, path)` | ~86–98 | Returns path of split/index pairs to reach a pane |
| `findPaneBelow(node, paneId)` | ~100–113 | Finds the pane visually below a given pane in column splits |
| `mapLayoutTree(node, updater)` | ~115–123 | Recursively maps/transforms all nodes in layout tree |
| `normalizeLayoutNode(node)` | ~125–147 | Deduplicates tab IDs, collapses single-child splits |
| `removePaneFromLayout(node, paneId)` | ~149–178 | Removes a pane and collapses parent splits |
| `replacePaneWithSplit(node, paneId, direction, newSibling, position)` | ~180–193 | Replaces a pane with a new split containing original + sibling |
| `sanitizeTabsById(tabsById, root)` | ~195–276 | Removes orphaned and unsupported tabs not referenced in layout |
| `normalizePersistedWorkbenchState(state)` | ~278–290 | Full normalization of persisted state; filters removed/unsupported tab types |

## Dependencies

- `../workbench/types` — all type definitions used across components and store
- `../workbench/utils` — layout tree manipulation utilities used by the store
- `./ContextMenu` — context menu component and types used in WorkbenchTabs

## Behavior

- The store persists to localStorage under `foxwarm_workbench_state_v4` using Zustand's persist middleware, with legacy migration from v3 keys.
- Tab operations (upsert, remove, reorder, move) immutably transform the layout tree and tab registry, maintaining active tab fallback logic when tabs are removed.
- Splitting a pane creates a new split node wrapping the original pane and a new sibling pane; empty panes are automatically removed from the tree after tab moves.
- `normalizeLayoutNode` collapses single-child splits and deduplicates tab IDs on every tree mutation.
- Drag-and-drop uses `@dnd-kit` with sortable tabs within rows and droppable zones on pane edges/center for cross-pane moves and splits.
- Wheel events on tab strips are intercepted to enable horizontal scrolling, and active tabs are auto-scrolled into view.
- Context menus support keep (promote from preview), copy ID/path, close, and bulk close operations.
- Bulk close operations still run each tab's ordinary resource and component close lifecycle. `Close others` preserves its target tab, while `Close all` may leave the pane empty and a forced Setup tab remains protected. Route fencing and final publication are canonical in [D-webui-app-route-close](./webui-app.md#d-webui-app-route-close).
- Tab-level pinning has been removed. Persisted v4 and migrated v3 records may still contain a legacy `pinned` key; normalization accepts the record, strips that key, and future writes preserve the existing tab order in one row.
- Persisted state normalization intentionally drops old `workspace` and `file` tab records; preserves current `vscode`, `agents`, and `setup` tabs (normalizing the Code title); and prunes panes that only referenced removed tab types.

## Integration

- `WorkbenchLayout` is the top-level layout renderer, receiving a `renderPane` callback that connects pane IDs to actual content components elsewhere in the app.
- `useWorkbenchStore` is consumed by parent orchestration components to open chat, terminal, Agents, Setup, and Code tabs, manage focus, and handle drag-end events that call `moveTabToPane`, `dockTabToPaneEdge`, or `splitPaneWithTab`.
- The `reconcileTabs` action allows external systems (e.g., session managers) to bulk-update tabs and layout atomically.
- `getWorkbenchTabById` provides non-reactive access for imperative code outside React components.
- Drop target types (`WorkbenchDropTarget`) define the contract between drag-end handlers and store actions.
