# Unit: webui-session-list

Files: packages/webui/src/components/SessionListCore.tsx, packages/webui/src/components/SessionList.tsx, packages/webui/src/components/CollapsedSidebar.tsx, packages/webui/src/boundedSessionList.ts, packages/webui/src/boundedSessionReplay.ts, packages/webui/src/sessionIdleNotifications.ts, packages/webui/src/sessionListPresentation.ts, packages/webui/src/sessionListDrag.ts, packages/webui/src/sessionRuntimeState.ts, packages/webui/test/boundedSessionList.test.mjs, packages/webui/test/boundedSessionReplay.test.mjs, packages/webui/test/sessionRuntimeState.test.mjs, packages/webui/test/sessionListDrag.test.mjs, packages/webui/test/sessionListDrag.e2e.mjs, packages/webui/test/sessionIdleNotifications.test.mjs
Secondary files: packages/webui/src/components/ContextMenu.tsx, packages/webui/test/sessionListAndWorkbenchState.test.mjs, packages/webui/test/sessionListLiveRefresh.e2e.mjs, packages/webui/test/scrollState.e2e.mjs

## Purpose

Renders a hierarchical, interactive session list for the Foxwarm web UI. `SessionListCore` handles tree rendering, list display modes, expand/collapse, drag-and-drop, context menus, and session management actions (archive, rename, delete, fork). `SessionList` wraps it with a full-page layout including header, navigation buttons, settings, and tab creation controls.

## Key Exports

- `SessionListCore` — default export; renders the fixed search/mode toolbar plus the recursive scrollable session tree with all interactive behaviors
- `Session` — TypeScript interface describing a session object (exported from `SessionListCore`)
- `useBoundedSessionList` — normalized server-page/exact/search cache and bounded SSE controller used by App and embedded Sidebar roots
- `SessionList` — default export; full sidebar/page wrapper around `SessionListCore`, including pass-through of global UI settings controls such as color mode and UI theme style

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `getSessionFilterFields(session)` | ~55 | Collects searchable session fields (display name, id, aliases, agent/node/cwd/model metadata) |
| `sessionMatchesFilter(session, normalizedQuery)` | ~70 | Case-insensitive predicate for session-list search |
| `getRuntimeStateSummary(runtimeState)` (sessionRuntimeState.ts) | helper | Formats runtime-state badges such as `thinking`, `tool: exec`, `waiting: sessions`, or `idle`. |
| `isSessionRuntimeActive(session)` (sessionRuntimeState.ts) | helper | Treats `requesting-model` and `running-tool` as active, falling back to legacy `busy`. |
| `useSessionIdleNotifications(sessions)` (sessionIdleNotifications.ts) | hook | Owns browser-local idle-notification modes and observes accepted global session-list snapshots once per list-data root. |
| `SessionIdleNotificationTracker` (sessionIdleNotifications.ts) | helper | Tracks a session's observed busy cycle until its later canonical idle state. |
| `getStoredAuthToken()` | ~160 | Retrieves the current auth token from localStorage |
| `formatPromoteApiError(response)` | ~70–105 | Formats structured/non-JSON promote API errors for user-facing alerts |
| `formatPromoteNetworkError(err, session?)` | ~107–120 | Formats fetch/network failures, including a busy-is-not-blocker note when relevant |
| `findScrollableParent(element)` | ~72–90 | Walks DOM to find nearest scrollable ancestor |
| `isFullyVisibleInContainer(element, container)` | ~92–98 | Checks if element is fully within container viewport |
| `DraggableSessionRow(props)` | ~100–130 | Wrapper component enabling full-row drag-and-drop on a session row while suppressing accidental click selection after pointer movement |
| `SessionListCore(props)` | ~132–end | Main component: state, tree logic, API calls, rendering |
| `compareSessionListSessions(a, b, mode)` | sessionListPresentation.ts | Partitions pinned before unpinned, then applies the mode's archived/order/time comparator |
| `getSessionListDisplayId(sessionId, parentSessionId, isDirectChild?)` | sessionListPresentation.ts | Produces row-only labels by removing the existing parent prefix or, for direct children, the agent prefix under an `<agent>/main` session |
| `shouldElevateSessionToRoot(session, mode)` | sessionListPresentation.ts | Elevates pinned sessions in tree modes and all sessions in Flat mode |
| `shouldEnableSessionListDrag(requested, primaryPointerCoarse)` | sessionListDrag.ts | Disables row drag affordances when the list opts out or the primary pointer is coarse |
| `shouldActivateSessionListDrag(enabled, pointerType)` | sessionListDrag.ts | Lets only mouse pointer events activate the dnd-kit row sensor, preventing touch/pen swipe activation |
| `useBoundedSessionList(options)` | boundedSessionList.ts | Loads ordered root/child windows, exact focus/open/watch rows, server search, and bounded SSE deltas with independent latest-request generations |
| `replayAtomicWindows(...)` / `replayCursorWindow(...)` / `replayCursorBranches(...)` | boundedSessionReplay.ts | Atomically reconstruct one revision-bound root-plus-branches operation through capped cursor pages, restarting the whole operation on reset/revision change |
| `mergeForcedPresentationPath(...)` | boundedSessionReplay.ts | Adds an exact off-page focus path as one bounded root/child render chain without replacing the ordinary forest |
| `mergeHttpRows(...)` / `mergeDeltaRows(...)` | boundedSessionReplay.ts | Enforces per-row monotonic SSE epoch/tombstone precedence over older HTTP responses |
| `captureExactAliasKeys(...)` / `applyExactMissTombstone(...)` | boundedSessionReplay.ts | Binds a by-ID alias request to its raw alias plus known canonical/alias identities and applies one miss tombstone set |
| `loadStoredSessionListViewMode()` / `getNextSessionListViewMode(mode)` | top-level helpers | Persist and cycle the sidebar list mode: default, time, or flat time. |
| `resolveSessionId(sessionId)` | ~165 | Resolves aliases to canonical session IDs |
| `visibleSessionIds` / `visibleParentMap` memos | component memos | Render only the server-selected rows and their canonical/forced focus relations |
| `loadDescendantSummary(sessionId)` | component closure | Fetches complete recursive count/busy preview for lifecycle UI without traversing a partial client tree |
| `toggleExpanded(sessionId)` | ~250 | Toggles expand/collapse state for a session node |
| `showMoreChildren(sessionId)` | ~255 | Increases visible child count for a session |
| `handleContextMenu(event, sessionId)` | ~260 | Opens context menu at click position |
| `handleMenuButtonClick(event, sessionId)` | ~275 | Opens context menu anchored to the menu button |
| `archiveSession(sessionId)` | ~290 | Sends PATCH to toggle session archived status |
| `togglePinned(sessionId, pinned)` | SessionListCore closure | Calls the authenticated pin route and relies on the session-list SSE refresh |
| `deleteSession(sessionId)` | ~305 | Sends DELETE to remove a session |
| `forkSession(sessionId)` | ~320 | Sends POST to fork/duplicate a session |
| `promoteSession(sessionId, targetParentId?)` | ~530 | Calls the promote/move-up endpoint and reports structured failure details |
| `renameSession()` | ~335 | Sends PATCH to update session display name |
| `renderSession(session, depth)` | ~355 | Recursively renders a session row and its children |
| `SessionList(props)` | (SessionList.tsx) | Layout wrapper with header, buttons, and SessionListCore |

## Dependencies

- `./ContextMenu` — `ContextMenu` component and types (`ContextMenuAnchorRect`, `ContextMenuEntry`)
- `../config` — `API_BASE_PATH` for API requests
- `./SessionListCore` — re-exported `Session` type and core component used by `SessionList`
- `./CreateTabButton` — button for creating terminal tabs
- `./GlobalUiSettingsMenu` — settings dropdown in the header

## Behavior

- Builds a tree from the current bounded server-selected rows and forced focus path. It never assumes the input is a complete Session catalog; flat-time rows render top-level.
- Session row labels preserve the existing full-parent-prefix omission. In addition, a child rendered under `<agent>/main` whose ID starts with `<agent>/` is shown from the slash onward (for example, `<agent>/task` displays as `/task`); canonical IDs, tree relations, search fields, and navigation remain unchanged.
- Pinned sessions form a top-level, pinned-first presentation partition in all three modes. A pinned child is removed from its parent's rendered children without mutating the real `parentSessionId`; unpin restores it to the real tree.
- The search bar includes a compact mode switch; each mode and search is ordered by the server:
  - `Default` uses saved `sidebarOrder` when present (falling back to recency) and allows drag reorder plus parent changes.
  - `Time` ignores `sidebarOrder`, sorts by recent activity, and disables sibling-order drops while still allowing parent/detach drops with `updateOrder:false`.
  - `Flat` ignores both `sidebarOrder` and parent relationships, showing all sessions at the top level by recent activity.
- Within pinned and unpinned partitions, Default still uses `sidebarOrder`, while Time/Flat use recency. The browser does not re-sort server ties. The collapsed rail owns a separate 20-root Default window and preserves its server order.
- Provides a compact fixed search/mode toolbar. Search uses the bounded backend's JavaScript-compatible matcher and renders server order; no local full-catalog filter remains.
- Session cwd remains part of `getSessionFilterFields`, so users can search by path, but cwd is not rendered in any row (desktop, mobile, or Code embedded sidebar). The selected session's cwd is presented in the Chat header instead.
- Automatically expands ancestors for the current session as parent/tree metadata changes, but arms active-row scrolling only when the canonical `currentSession` selection actually changes. Unrelated `sessions-updated` refreshes must not pull a user-scrolled sidebar back to the active row.
- Context menu provides archive/unarchive, rename, fork, and delete actions via REST API calls. Delete/archive confirmations use the backend descendant preview's complete recursive count and busy summary, not the partial loaded tree; archive remains one-click when the fetched count is zero, and unarchive remains one-click.
- Context menu presents `Notify on idle` as an ordinary menu-item row. Its main action controls `once`, while a separate trailing `always` checkbox stops event propagation before selecting/toggling that mode. A persistent Bell icon is outlined while disabled and active for either enabled mode; enablement stays browser-local and asks for browser notification permission without a backend request.
- Context menu provides pin/unpin without adding a permanent row button; pinned rows carry a small pin indicator with accessible text.
- Context menu provides move-up/promote-to-root actions for child sessions; frontend error handling preserves backend code/reason details and distinguishes API vs network failures.
- Supports drag-and-drop via `@dnd-kit/core` for session reparenting/reordering and for opening sessions in workbench panes. The whole session row is draggable (no separate visible handle) while nested controls stop pointer propagation as needed. Sidebar sibling reorder drops are registered only in `Default` mode; parent/detach drops remain in `Time` mode and are disabled in `Flat` mode. This is dnd-kit's pointer sensor, not native HTML `draggable`.
- `dragEnabled={false}` keeps all normal selection/search/context-menu behavior but removes draggable row/drop affordances. The mobile full-page `SessionList` and Code's sidebar-only leaf use this because neither exposes a reliable row-drag workflow. `SessionListCore` also disables drag when `(pointer: coarse)` is the primary input and filters touch/pen activations even when drag remains enabled for a mouse.
- The list scroll container declares `touch-action: pan-y` (`touch-pan-y`), so vertical touch movement belongs to native scrolling from the start rather than briefly entering a drag overlay/state.
- Pinned sessions remain draggable into workbench panes, but cannot act as sidebar parent/order targets and cannot be reparented/reordered until unpinned; this prevents presentation elevation from being mistaken for a real root parent.
- Uses backend recursive/batched active-descendant summaries for lifecycle confirmation and collapsed-parent activity; it never derives completeness from loaded descendants. Active counts use canonical `requesting-model` / `running-tool` state with legacy `busy` fallback, while waiting and queue-only idle sessions are not counted as active.
- Renders state-specific badges in each row: blue `thinking`, purple `tool: <name>` with batch index when available, amber `waiting: sessions|exec|timer`, and no noisy badge for idle sessions. Bare/reason-only `wait` and queue-only canonical-idle sessions are idle for display.
- Collapsed sidebar dots also use runtime-state colors (blue model, purple tool, amber waiting) so waiting sessions remain distinguishable when the sidebar is collapsed.
- Implements server-backed progressive disclosure with opaque child cursors and top-level opaque root continuation (50 rows per click in expanded Sidebar; 20 roots in collapsed rail).
- Root replay walks pages at the backend's 100-row cap; expanded branches replay in batches of at most 20 parents and 20 rows per page. Reset or any presentation-revision mismatch across root pages, first-page child batches, continuations, or the root-to-branch boundary restarts the entire bounded replay before one atomic publish, including previously requested depths above one server page.
- Exact misses tombstone the raw requested alias plus cached/current canonical and alias identities. Eligibility is per captured canonical row: a canonical row newer than the request and every alias still present on that row are preserved, while the missing raw alias and aliases removed by the newer row are tombstoned. Root/search HTTP rejects a row when either its ID or any returned alias has a newer tombstone; pruning retains obsolete tombstones until all older in-flight row requests settle.
- Current/open/idle-watch exact IDs are never truncated: by-ID HTTP and global SSE subscriptions are chunked at 100 while preserving every accepted ID.
- Even with no exact/structural rows yet, the controller owns one invalidation-only global SSE connection. Each capped subscription owns and replaces one EventSource/reconnect timer, and sibling streams deduplicate versioned invalidation events while legacy events still coalesce. Every new/reconnected batch schedules the existing coalesced bounded refresh after open, covering an invalidation emitted while subscriptions were being replaced without reconnecting stable signatures.
- Ordinary collapsed-parent busy badges come from the bounded batch descendant-activity projection over active ancestor paths. Lifecycle dialogs independently reload exact recursive totals/busy previews and clear stale summaries on catalog invalidation.
- Context-menu relation rows and descendant summary/loading generations are retained only while their menu/dialog owner is active; close, mode/search/focus/ownership change, invalidation refresh, and unmount clear obsolete state.
- Rename and delete use modal dialogs with confirmation
- Elapsed time display for busy sessions updates via interval timer

## Integration

- `SessionList` is used as the main sidebar/mobile view in the app shell, receiving session data, global UI preference controls (including `uiThemeStyle`), and callbacks from a parent container
- Communicates with the backend via `fetch` to `API_BASE_PATH` endpoints (`/sessions/:id`, `/sessions/:id/fork`, `/sessions/:id/promote`)
- Drag data (`type: 'session'`) integrates with a `@dnd-kit` `DndContext` higher in the component tree for session reparenting
- `onSelectSession` and `onKeepSession` callbacks connect to the app's routing/tab management
- Normal App and embedded sidebar roots each provide one bounded controller plus one idle-notification observer. Current/open/watch exact IDs stay subscribed even off-page; off-page absence is not deletion, while exact lookup/SSE deletion explicitly removes the row.
- `onCreateTerminalTab` / `onCreateSession` connect to the app's tab system
- `data-session-list-scroll-container` attribute is on the internal scrollable list area and is used by `findScrollableParent` to locate the scroll container for auto-scroll behavior
- `packages/webui/src/sessionRuntimeState.ts` is shared by `SessionListCore`, collapsed sidebar, `ArchitectureView`, `Chat`, and `App` so all WebUI active-count/status behavior uses the same fallback rules.

## Design Decisions

- [2026-07-14] Sidebar active-session positioning is selection-driven, not session-list-refresh-driven. Parent-map refreshes may expand the current session's ancestors, but only a canonical current-session ID change may arm `scrollIntoView`; ordinary runtime/history metadata broadcasts preserve the user's manual sidebar scroll.
- [2026-07-20] Vertical touch scrolling in the mobile session list must never enter drag visuals/state. Disable row drag for the mobile/coarse-pointer UI and reject touch/pen drag activation while preserving desktop mouse drag/reorder; do not invent a long-press mobile reorder interaction.
- [2026-07-20] Session-list rows do not display cwd, including desktop/mobile/Code-embedded reuse paths, but cwd remains searchable filter metadata. Present it in the selected Chat header subtitle instead.
- [2026-07-24, updated 2026-08-11] `Notify on idle` is browser-local and is armed only after Notification API permission is granted. It fires only after an observed active busy phase (`requesting-model` or `running-tool`, with legacy `busy` fallback) returns to canonical/display `idle`; queue-only canonical idle state neither arms nor fires a transition, regardless of positive queue count. An active-to-`waiting` change does not fire and remains armed until idle. Enabling while idle waits for a later busy cycle, while enabling during an active phase arms that current cycle. `once` removes itself after delivery and `always` rearms for later cycles. Its ordinary menu-item main action selects or toggles off `once`; a separate trailing `always` checkbox stops propagation and selects or toggles off `always`, preserving mutual exclusion. A persistent Bell icon is outlined while disabled and active for either enabled mode. Baselines belong to the global list-data root rather than any `SessionListCore` presentation, avoiding duplicate notifications from component reuse without adding cross-tab coordination.
- Recursive lifecycle confirmation follows the canonical contract in [D-lifecycle-descendant-actions](../threads/session-lifecycle.md#d-lifecycle-descendant-actions).
