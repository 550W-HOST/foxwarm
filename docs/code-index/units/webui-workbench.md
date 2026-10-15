# Unit: webui-workbench

Files: packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/src/components/WorkbenchLayout.tsx, packages/webui/src/components/WorkbenchPane.tsx, packages/webui/src/components/WorkbenchTabs.tsx, packages/webui/src/components/WorkbenchTabHeader.tsx, packages/webui/src/components/WorkbenchTabErrorBoundary.tsx, packages/webui/src/components/useWorkbenchTabMenu.tsx, packages/webui/src/workbench/store.ts, packages/webui/src/workbench/types.ts, packages/webui/src/workbench/utils.ts, packages/webui/test/sessionListAndWorkbenchState.test.mjs, packages/webui/test/systemTabs.e2e.mjs, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/workbenchTabErrorBoundary.e2e.mjs

## Purpose

Manages a multi-pane workbench UI with tabbed panels, tab and whole-pane drag-and-drop, direction-aware pane collapse, resizable split layouts, and persistent state. Provides the layout tree structure, tab management store, and rendering components for a VS Code-style tabbed shell.

## Key Exports

- `WorkbenchLayout` — recursive component rendering split/pane layout tree with resizable panels
- `WorkbenchPane` — layout chrome with tab bar, collapsed/empty drop zones, toolbar controls, and an empty content slot
- Shared slot geometry and tab-owned contents are documented in [Workbench content hosts](./webui-workbench-content.md).
- `WorkbenchTabErrorBoundary` — leaf boundary that contains one tab's render failure and offers explicit Retry/Close actions
- `WorkbenchTabs` — single-row sortable inset editor tabs with the shared tab menu
- `WorkbenchStatusBar` — desktop icon/count footer for running Sessions, loaded waiting Sessions, active/unfinished tasks, ready Nodes, global token usage, focused-Chat cumulative usage, and the Terminal panel toggle
- `WorkbenchTabHeaderProvider`, `WorkbenchTabClose`, `WorkbenchTabIcon`, `WorkbenchPaneControls` — pane-owned sole-tab controls, tab drag handle, and pane toolbar for content headers
- `useWorkbenchTabMenu` — existing Keep/copy/popout/close actions shared by strips and header icons
- `useWorkbenchStore` — Zustand store with all workbench state and actions
- `getWorkbenchTabById` — standalone accessor for a tab by ID
- `WorkbenchTab`, `WorkbenchLayoutNode`, `WorkbenchPaneNode`, `WorkbenchSplitNode`, `WorkbenchPersistedState`, `WorkbenchDropTarget` — core types, including `chat`, `terminal`, `vscode`, `agents`, `search`, `logs`, `tasks`, and `setup` tab records
- `createPaneNode`, `createSplitNode`, `createWorkbenchId`, `findPaneNode`, `findPaneContainingTab`, `getPaneIds`, `getPaneNodes`, `getFlattenedTabIds`, `mapLayoutTree`, `removePaneFromLayout`, `replacePaneWithSplit`, `normalizePersistedWorkbenchState`, `findPaneBelow` — layout tree utilities

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `ResizeHandle({ direction })` | ~16–19 | Renders styled separator handle for resizable panels |
| `LayoutPanel(props)` | WorkbenchLayout.tsx | Applies fixed-pixel constraints to collapsed panels and restores the recorded expanded size after the panel library registers new constraints |
| `WorkbenchLayout(props)` | WorkbenchLayout.tsx | Recursively renders split groups and passes each pane's direct parent direction to its chrome |
| `PaneDropZone(props)` | WorkbenchPane.tsx | Droppable edge/center overlay for the existing DND context |
| `PaneDropTargets(props)` | WorkbenchPane.tsx | Shows tab/session drop targets or edge-only whole-pane targets, excluding the dragged pane itself |
| `PaneDragHandle(props)` | WorkbenchPane.tsx | Registers a separate four-way move handle with pane ID and `type: 'pane'` drag data |
| `ToolbarButton({ title, disabled, onClick, children })` | ~40–50 | Styled icon button for pane toolbar actions |
| `WorkbenchPane(props)` | WorkbenchPane.tsx | Renders expanded tabs/slot or content-free collapsed chrome, plus shared pane controls and collapsed/empty drop targets |
| `WorkbenchTabErrorBoundary` | WorkbenchTabErrorBoundary.tsx | Contains one tab render failure, logs diagnostics, and exposes explicit Retry/Close controls |
| `TabIcon({ type })` | ~38–42 | Returns icon component based on tab type |
| `isHorizontallyFullyVisible(element, container)` | ~44–49 | Checks if element is fully visible within container bounds |
| `getNormalizedWheelDelta(event, container)` | ~51–60 | Normalizes wheel event delta across delta modes |
| `copyTextToClipboard(text)` | useWorkbenchTabMenu.tsx | Copies text to clipboard with fallback to execCommand |
| `getTabCopyId(tab)` | useWorkbenchTabMenu.tsx | Returns copyable identifier for a tab |
| `getTabCopyPath(tab)` | useWorkbenchTabMenu.tsx | Returns copyable cwd for terminal tabs |
| `TabStripRow(props)` | ~92–165 | Renders the pane's single row of sortable tabs |
| `SortableTab(props)` | ~167–230 | Individual draggable/sortable tab element with interactions |
| `WorkbenchTabs(props)` | ~main export | Full single-row tab bar with shared menu and toolbar |
| `useWorkbenchTabMenu(options)` | useWorkbenchTabMenu.tsx | Owns shared tab menu state, entries, pointer and keyboard anchors |
| `WorkbenchTabClose(props)` | WorkbenchTabHeader.tsx | Calls the exact pane-owned tab close callback without starting a drag |
| `TabDragHandle(props)` | WorkbenchTabHeader.tsx | Registers the sole-tab icon in the existing DND context and exposes tab actions |
| `WorkbenchTabIcon(props)` | WorkbenchTabHeader.tsx | Uses a draggable icon only inside a single-tab Workbench provider |
| `WorkbenchPaneControls()` | WorkbenchTabHeader.tsx | Places the pane-owned toolbar in the existing sole-tab content header |
| `setPaneCollapsed(paneId, collapsed)` | store.ts | Changes only pane collapse state, preserving tab records and resource lifecycles |
| `movePaneToEdge(sourcePaneId, targetPaneId, edge)` | store.ts | Removes the source pane's old layout position and docks the intact node beside the target |
| `readJsonStorageItem(key)` | ~16–22 | Safely reads and parses JSON from localStorage |
| `loadLegacyWorkbenchState()` | ~24–34 | Migrates legacy v3 tab storage to v4 layout format |
| `getDefaultWorkbenchState()` | ~36–48 | Returns initial state, migrating legacy data if present |
| `insertIntoArray(items, value, index)` | ~75–81 | Immutably inserts value at index in array |
| `removeFromArray(items, predicate)` | ~83–89 | Immutably removes first matching item, returns removed index |
| `getPaneAfterTabRemoval(pane, tabId)` | ~91–100 | Computes pane state after removing a tab with fallback active |
| `getInsertedPane(pane, tabId, options)` | ~102–118 | Computes pane state after inserting a tab at position |
| `createWorkbenchId(prefix)` | ~5–10 | Generates unique ID with crypto.randomUUID or fallback |
| `createPaneNode(tabIds, activeTabId, id, collapsed)` | utils.ts | Creates a pane node, defaulting collapse state to false |
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

- Desktop App encloses Sidebar and pane surfaces in rounded, theme-token-based inset panels with small functional resize gutters. Corner styling never clips Sidebar dropdowns; split widths, DND targets, and Code iframe lifecycle remain owned by their existing mechanisms. Mobile and embedded leaf views remain edge-to-edge.
- The current editor tab joins the content-header surface without an intervening border or scrollbar gutter; inactive tabs sit on the quieter strip. Close slots keep their width but show on current/hover/focus tabs (always on coarse pointers). Tab overflow retains wheel scrolling; an idle-hidden, keyboard-operable overlay range controls the horizontal scroll position without reserving a stripe between the current tab and content.
- The 24px desktop status bar occupies only the right workbench column; Sidebar remains full height and mobile has no status footer. Short icon/label/count controls use visibly stronger hover/selected surfaces and open viewport-clamped upward popovers, never direct tab navigation. Running uses the existing bounded global summary, waiting explicitly refers to loaded Sessions, and ready Nodes reuse App's Node targets. Task counts read exact API totals with `limit=1` per open/active status, refresh once per minute only while visible and on visibility return, and synchronize immediately with same-page Tasks reads. Failed/unavailable counts are hidden rather than shown as zero; pending reads, timer, and event listeners are released on unmount. Global token usage reuses the catalog totals already fetched by App's bounded summary controller; focused-Chat usage uses the exact current Session row and disappears on non-Chat focus. Both share [TokenUsageDetails](./webui-token-usage-details.md), including Cached/Input/Output percentages, and add no global Session hydration or independent usage polling. They describe cumulative usage, not current request context size. Narrow desktop columns collapse short labels while keeping accessible names and counts. Session/Node popovers reuse bounded loaded rows. Opening Tasks reads at most three rows per active/open status; closing or switching cancels the read. Escape/outside pointer dismisses, and Escape restores trigger focus.

- The store persists to localStorage under `foxwarm_workbench_state_v4` using Zustand's persist middleware, with legacy migration from v3 keys.
- Tab operations (upsert, remove, reorder, move) immutably transform the layout tree and tab registry, maintaining active tab fallback logic when tabs are removed. User activation (`activateTab`, `setPaneActiveTab`, or an activating insert/move) clears the target pane's collapsed state, including when the requested tab is already active; background insertion and route/hydration bookkeeping can preserve collapse explicitly.
- Splitting a pane creates a new split node wrapping the original pane and a new sibling pane; empty panes are automatically removed from the tree after tab moves.
- `normalizeLayoutNode` collapses single-child splits and deduplicates tab IDs on every tree mutation.
- Drag-and-drop uses `@dnd-kit` with sortable tabs within rows and droppable zones on pane edges/center for cross-pane moves and splits.
- The tab Close button stops its pointer-down event before the sortable tab drag listener; pointer motion within that small control cannot start a tab drag instead of closing it. The rest of the tab remains draggable.
- Wheel events on tab strips are intercepted to enable horizontal scrolling, and active tabs are auto-scrolled into view.
- Sole non-Code tabs omit the strip in every expanded pane and put applicable pane controls in the existing content header. Code retains its single-tab strip. Collapse, whole-pane drag, and `Close pane` are absent when the entire workbench has only one pane, regardless of its tab count; split controls and ordinary tab drag/Close retain their existing behavior. A lone pane that was already collapsed still exposes expansion. Header behavior is owned by [Single-tab headers](#single-tab-headers).
- Collapse and whole-pane movement are defined by [Pane collapse](#d-workbench-pane-collapse) and [Whole-pane dragging](#d-workbench-pane-drag). Neither operation invokes tab resource Close.
- Stable content, admission, positioning, and tab error isolation are owned by [D-workbench-stable-content](./webui-workbench-content.md#d-workbench-stable-content). A thrown tab render leaves the tab strip, Sidebar, and other tabs mounted; its fallback offers explicit Retry and ordinary tab Close when closable. Forced Setup and empty panes show no ineffective Close action; Retry never loops automatically.
- Context menus support keep (promote from preview), copy ID/path, close, and bulk close operations.
- Context menus also expose `Move to new window` for every tab type. A terminal draft keeps the item disabled until it has a backend terminal ID. App owns popup/confirmation/route behavior and removes the tab through the ordinary layout-only store action without invoking its separate resource-close lifecycle.
- Bulk close operations still run each tab's ordinary resource and component close lifecycle. `Close others` preserves its target tab, while `Close all` may leave the pane empty and a forced Setup tab remains protected. Route fencing and final publication are canonical in [D-webui-app-route-close](./webui-app.md#d-webui-app-route-close).
- Tab-level pinning has been removed. Persisted v4 and migrated v3 records may still contain a legacy `pinned` key; normalization accepts the record, strips that key, and future writes preserve the existing tab order in one row.
- Persisted state normalization intentionally drops old `workspace` and `file` tab records; preserves current `vscode`, `agents`, `search`, `logs`, `tasks`, and `setup` tabs (normalizing Code and deriving each History title from its optional draft query); and prunes panes that only referenced removed tab types. The legacy `system:search` tab remains readable. New History instances use independent IDs and retain their query draft metadata for routing, moving, closing, and restore; archive results are not written to localStorage. Their History icon matches the footer history-clock icon.
- Chat previews use the same `chat:<sessionId>` ID as kept tabs; `preview` is a presentation/reuse flag, not a separate tab identity. Persisted old previews whose ID does not name their Session (including legacy random IDs) are discarded along with their layout references. Current canonical previews and kept tabs survive reload; unrelated tabs remain intact.

Tasks tab identity, read-only bounded display and popout semantics are documented in [WebUI Tasks](./webui-tasks.md).

Logs tab identity, bounded display and popout semantics are documented in [WebUI Logs](./webui-logs.md).

### Single-tab headers

- Each sole non-Code tab has a content-header Close control and an icon drag handle. Chat and Setup use `ContentHeader`; Terminal, Agents, History, Logs, and Tasks retain their own header layout. Terminal's compact X and adjacent terminal icon fit inside its existing status row.
- The tab-owned content host projects the current pane context with the exact tab, ordinary close/menu callbacks, and pane toolbar only while the strip is hidden. `WorkbenchPaneControls` places available pane movement, collapse/expansion, and Close controls beside the content header's existing actions without a second title bar or an overlapping floating toolbar. It is absent from popup and Code-embedded leaf roots. Setup suppresses its duplicate right-side tab Close in this mode; forced OOBE still refuses closure through App's existing guard.
- Only the icon registers `useDraggable` with the existing tab ID and `{ type: 'tab', paneId }` data. The strip and icon never register the same ID simultaneously. Header/title/Close are not drag activators; Close isolates pointer-down. App's existing drag-end, Keep, overlay, and center/edge drop semantics remain unchanged.
- Icon click, context menu, or Shift+F10 opens the shared existing tab menu, retaining Keep, copy, Move to new window, and close operations. A terminal without a backend ID retains the existing disabled popout action. Header X uses App's ordinary resource-close and route-fencing lifecycle, not Back navigation.

### D-workbench-pane-collapse

The pane toolbar exposes Collapse only when the workbench has multiple panes. Expand remains available for a collapsed pane even when it is the only pane, including a persisted collapsed root or a pane left after its siblings close; clicking a collapsed tab also expands it. A pane's direct parent split sets the direction: row splits use a narrow vertical tab list, column splits use a horizontal tab bar, and a single root pane defaults to the horizontal bar. Fixed-pixel panel constraints release space to siblings; expansion restores the pane's recorded size after the panel library applies its new constraints. Separator dragging does not silently collapse panes. Stored split sizes are not overwritten while a direct child pane is collapsed, so reload retains a reasonable expansion size. Live Group defaults are reseeded only when the child topology changes, not on every size publication. When all direct children are collapsed panes, compact chrome is rendered without a resizable Group rather than forcing a tab bar to fill the empty space.

Collapsed chrome renders only tab labels, pane controls, and DND targets for ordinary tabs. Ordinary active content is not admitted while collapsed; the tab strip and content header are also absent. Tab records and selection remain intact; clicking a collapsed tab selects it and expands the pane. Terminal component cleanup detaches its browser connection without deleting the PTY. Code and History retain their existing hidden-instance semantics through the shared content host, as defined by [D-workbench-stable-content](./webui-workbench-content.md#d-workbench-stable-content).

Pane `collapsed` state is saved in the existing v4 layout. Normalization defaults missing or non-true values to expanded and preserves true values while pruning obsolete tabs, without a new storage version.

### D-workbench-pane-drag

A dedicated four-way move handle drags the entire pane, including its ID, ordered tab records, active tab, and collapse state. The handle is separate from the ordinary tab/icon drag activator and is available in collapsed chrome when the workbench has multiple panes. It is absent for a lone pane regardless of tab count. Pane dragging uses the existing DND context, overlay, pane edge highlights, and layout-tree removal/split helpers. Left/right/top/bottom edges dock the intact pane beside the target; center and tab-row targets do not merge or swap panes. Self-drops and cancellation leave the layout unchanged. A moved collapsed pane derives its chrome direction from its new direct parent split.

Pane movement does not Keep previews, duplicate tabs, or close resources. Ordinary tab and Sidebar dragging retain their existing reorder, Keep, center, and edge behavior.

### D-workbench-terminal-panel

[2026-10-12] Desktop Terminal launch belongs to the leftmost status-bar control. It opens a lower ordinary workbench pane, initially around 260px (bounded to 25–50% of its source pane), or reuses an exact normalized node/cwd target. Restored terminal tabs sharing the focused editor are docked below it; a terminal already dragged into another pane is reused there rather than moved back. New panel sizing is optional in `splitPaneWithNewTab`/`dockTabToPaneEdge`; ordinary splits retain 50/50 defaults.

The panel uses the existing pane/tab DND, divider resize, persisted layout, and terminal resource lifecycle. Status-button toggle and Collapse retain the PTY; Close on a terminal-only pane closes its terminal tabs through the ordinary backend DELETE path and removes the pane. Close must not migrate terminal tabs into another pane. Collapse and Close remain distinct actions. A mixed pane retains its ordinary close/migration behavior and its other content is not hidden by the Terminal toggle. Terminal-only Close unmounts its content before deletion; disposed connection starts must not create replacement PTYs after an awaited lookup. Mobile retains its header launcher because it has no desktop status bar.

## Tests

Responsive fixtures use one coherent geometry sample after the native scrollbar gutter is published. Desktop/mobile actions wait for their destination shell and resolve the current control while preserving actual pointer input and iframe identity checks.

- `workbenchPreview.e2e.mjs` covers preview identity, route/close behavior, drag promotion, focused Chat search, and actual App header launches. The header probes verify the 550A console's single Code control, preference-selected new-tab versus embedded opening, desktop footer Terminal target dispatch, and the mobile header fallback. Footer panel probes cover exact reuse, initial height, live resizing, collapse without deletion, intact pane dragging, Close with deletion and no automatic recreation, and explicit reopening. Application-menu probes cover leading icon geometry, Setup active state, Logs activation, and real reload navigation. Single-tab probes cover all normal leaf headers, Code strip retention, multi-pane hidden strips, actual icon drag/cancel/docking, Close pointer isolation, and Terminal status-row height plus backend DELETE, completed empty-root/empty-hash close, explicit reopen, and fallback to a still-open tab.
- Stable content lifecycle, geometry, request/DOM identity, and moved-content error-boundary tests are documented in [Workbench content hosts](./webui-workbench-content.md#tests).
- Pane browser probes cover row/column/nested collapse geometry, space release and size restoration, selected-tab expansion, reload, simultaneous collapsed panes, recovery of a persisted or remaining lone collapsed pane, single-pane control visibility independent of tab count, real Terminal detachment and kept Code unmounting without resource Close, the same kept Code iframe across collapse/expand including inactive Code, whole-pane movement across nested splits, collapsed direction after movement, and Escape cancellation. `sessionListAndWorkbenchState.test.mjs` covers collapse persistence and older v4 pane compatibility.

## Integration

- `WorkbenchLayout` receives a `renderPane` callback for pane chrome and empty registered content slots. App separately projects the stable tab-owned content list into `WorkbenchContentLayer`; geometry and lifecycle ownership are canonical in [D-workbench-stable-content](./webui-workbench-content.md#d-workbench-stable-content).
- `useWorkbenchStore` is consumed by parent orchestration components to open chat, terminal, Agents, Setup, Search, Logs, Tasks, and Code tabs, manage focus/collapse, and handle drag-end events that call `moveTabToPane`, `dockTabToPaneEdge`, `splitPaneWithTab`, or `movePaneToEdge`.
- The `reconcileTabs` action allows external systems (e.g., session managers) to bulk-update tabs and layout atomically.
- `getWorkbenchTabById` provides non-reactive access for imperative code outside React components.
- Drop target types (`WorkbenchDropTarget`) define the contract between drag-end handlers and store actions.

### D-workbench-text-controls

[2026-10-12] Text-entry controls use a small bounded corner radius, normal weight, semantic text/placeholder colors, and the manifest's dedicated control typography. The 16px focus-zoom floor is touch-only, not a desktop-wide override. Built-in composer radii and typography are reduced through their manifests; body and code typography remain independent. Monaco inputs and its controlled fallback are excluded from form-control overrides. This common rendering path applies to imported themes without theme-ID CSS branches.

Focused desktop panes retain neutral borders without the old accent ring. Focus ownership, routing, keyboard behavior, and active-tab indicators remain intact; this avoids a clipped colored outline appearing only at rounded pane corners. Chrome palette roles and the independent mode choices are owned by [D-webui-theme-v3-chrome](./webui-theme-system.md#d-webui-theme-v3-chrome).

The status bar itself is transparent and does not paint a full-width plate. Individual controls retain hover/focus/open highlights; theme status-surface data is an interaction base, not a permanent footer fill. Gallery and detailed previews use the same transparent footer treatment.
