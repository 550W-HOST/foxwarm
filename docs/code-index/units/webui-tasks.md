# Unit: WebUI Tasks

Files: packages/webui/src/components/StatusBadge.tsx, packages/webui/src/components/TasksView.tsx, packages/webui/src/components/TasksView.css, packages/webui/src/components/SessionSelector.tsx, packages/webui/test/tasksView.e2e.mjs
Secondary files: packages/webui/src/index.css, packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/src/components/NodesView.tsx, packages/webui/src/App.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/EmbeddedWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/workbench/types.ts, packages/webui/src/workbench/utils.ts, packages/webui/src/components/Sidebar.tsx, packages/webui/src/components/CollapsedSidebar.tsx, packages/webui/src/components/SessionList.tsx, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/sessionListAndWorkbenchState.test.mjs, packages/webui/test/popupWebUi.test.mjs

## Purpose

Provides a Tasks singleton workbench tab with Table and Board views, manual Refresh, task details, and the three authenticated user actions: create, comment and owner change/release. It observes tasks independently of Session history and does not add realtime subscriptions, card dragging or account/role controls.

## Key exports and function index

| Symbol | Responsibility |
|---|---|
| `StatusBadge` / `TaskStatusBadge` / `NodeStatusBadge` | Share the existing Tasks badge geometry and semantic tones without sharing Task/Node state models |
| `TasksView` | Own the selected view, bounded task windows, selected task details, loading/error states and manual refresh |
| `SessionSelector` | Controlled bounded Session search/exact hydration control shared by task creation and owner changes |
| `readTasks` | Read one deployment-relative JSON endpoint with cancellation and an actionable API error |
| `writeTask` | Send deployment-relative JSON user mutations and surface server task errors |
| `formatTime` / `formatRelativeTime` | Display full local timestamps and compact relative list dates |
| `SessionNames` / `SessionReference` | Hydrate bounded Session display names while retaining exact identity, copy, and navigation |
| `STATUSES` / `LIST_LIMIT` | Select all four status windows with at most 50 tasks each |

## Data and presentation

- `GET /api/tasks?status=<status>&limit=50` is read once for each of `open`, `active`, `completed`, and `cancelled`. Unfiltered API reads include only unfinished tasks, so the UI selects terminal statuses explicitly too. Table and Board share these four bounded windows (at most 200 tasks), ordered by descending `updatedAt` with ID tie-breaking. Work is the default scope and shows Open/Active, History shows Completed/Cancelled, and All shows all four statuses. Scope status counts describe the actually loaded window; bounded omitted counts remain secondary information instead of the primary summary.
- Table has Task, Status, Owner, and Updated columns. Titles use two bounded lines; Board titles use three. Owner labels are hydrated through bounded `/session-list/by-id` batches with exact-ID fallback; Agent metadata is a secondary line. Creator, full identity, descriptions, and results belong to details rather than every list row. Copy/navigation retain canonical Session IDs. Narrow tables become compact two-column rows instead of forcing horizontal document scrolling.
- The two-level header separates Refresh/New task from Work/All/History scope, loaded-window search, Agent selection, relationship-filter popover, and Table/Board icon controls. Search and Agent filters operate only on the bounded loaded windows; hidden/not-loaded counts remain secondary. Matching uses explicit owner/creator Agent metadata, never an inferred Agent from an ID.
- Clicking a title or card reads `GET /api/tasks/:id`. The detail response is `{ task, children, childrenOmitted, notes, notesOmitted }`; the panel shows description, immutable parent ID, owner, result, bounded children and notes. Note authors display `User` or the canonical Session ID from the explicit author projection. A child title selects that child's details. Text is rendered as React text, not HTML. On narrow viewports, selected details use a fixed full-screen dialog so they are immediately visible instead of being placed after a long list and can be closed with the existing close control; desktop keeps the side-panel layout without modal semantics.
- `New task` is the primary header action and opens a controlled form for title, description, optional owner Session and notification. Its full-page form and the narrow detail dialog portal to document.body under the [Workbench overlay boundary](./webui-workbench-content.md#d-workbench-stable-content); desktop details remain in the pane. The owner selector remembers the last successfully submitted owner in Tasks-local browser storage; failed or cancelled submissions do not change that default. Creation is a User action and never sends a selected Session as the creator.
- Task details provide a controlled owner selector with release, notification checkbox, and save action, plus a User comment form that may notify the current owner. Comments remain allowed for completed/cancelled tasks; owner changes follow the server terminal-state rule. User mutations refresh the selected detail/list after success and display delivery warnings/errors without pretending the selected Session authored the action.
- `SessionSelector` searches `/api/session-list/search` through bounded catalog projections, hydrates a selected ID through `/api/session-list/by-id`, shows real Agent metadata and canonical IDs, and uses latest-request cancellation. It is independent of the Sidebar tree and contains no authorization or account semantics.
- Each list/detail effect cancels its previous request on refresh, selection change or unmount. An obsolete response cannot publish state. Refresh rereads both the bounded list and the selected detail. Loading, empty and failure states remain visible and a later Refresh retries failed reads.
- URLs use `makeApiUrl`, including encoded detail IDs, preserving deployment prefixes. No task or note is copied into Chat history.

- Detail width responds to the actual Tasks pane through ResizeObserver: wide panes use a side inspector and narrow panes use a focused modal with Tab containment. Escape/outside pointer dismiss transient controls and restores list focus. Obsolete reads and mutations cannot replace another task's draft or details.
- Completed bounded status reads publish exact `open`/`active` API totals to the desktop status bar through a same-page count event; this does not add task realtime subscriptions.

Table/Board and the filter row use the shared centered reading column and outer gutter without reserving minimap space. Desktop filters retain the same main-column clearance as the side inspector, and can wrap when its remaining width is narrow. The pane-wide heading/actions and independently sized modal dialogs keep their existing roles. Geometry is canonical in [D-webui-shared-content-width](../modules/webui.md#d-webui-shared-content-width).

### Shared status badges

Tasks Table, Board, details and the status-bar task preview use the same `TaskStatusBadge`, including normal status labels, the existing five-pixel dot, five-pixel radius and 11px type. Page badges retain 3px/7px padding and an 18px line height; status-bar popup badges use a compact local override with 1px/5px padding and a 16px line height. Open/Cancelled remain muted, Active uses accent, and Completed uses success.

Node status labels reuse that visual component with Online/Offline wording and accent/muted tones. Upgrade required stays a separate warning badge; protocol explanations remain visible. This shares presentation only, not status meanings, counts, availability or permissions. Global `index.css` owns the small shared rules so a first popup has complete styling without importing or previously visiting the lazy Tasks page. Long row titles truncate while badges retain their readable width.

## Workbench integration

`system:tasks` uses the existing singleton activation, hash restoration, storage normalization, close fallback, split panes, tab menus and top-level popup flow. Navigation placement is defined by [D-webui-tasks-navigation](#d-webui-tasks-navigation). Code's embedded Sidebar opens the same-origin Tasks popup without adding a host bridge or embedded target kind. The sole-tab heading uses the ordinary Workbench icon/Close controls and [empty-header pane movement](./webui-workbench.md#d-workbench-pane-drag); popup leaves have no Workbench controls.

## Design decisions

### D-webui-tasks-user-actions

[2026-10-07] Tasks is a singleton workbench tab offering Table, Board, task details, manual Refresh, and only create/comment/owner user actions. User author identity is distinct from owner Session identity; no selected Session is used as the User actor. The UI adds no claim/complete/cancel controls, card dragging, account/role platform or task-specific realtime transport. Ordinary authenticated WebUI access retains its existing full-access contract.

### D-webui-tasks-navigation

[2026-10-11] Tasks has a persistent direct entry rather than a settings-menu row. Expanded desktop Session-list footers show an icon plus `Tasks` on the left, with History and settings on the right. Mobile primary navigation is separately owned by the [mobile shell contract](../threads/webui-mobile-shell.md#d-mobile-shell-presentation) and does not activate desktop singleton tabs. The collapsed rail shows only the Tasks icon above History and settings. These entries reuse the ordinary singleton activation callback and are omitted when that callback is unavailable. The Code-embedded Sidebar shows a direct Tasks icon beside its header settings button, retaining its same-origin popup behavior and blocked-popup feedback.

## Tests

- `tasksView.e2e.mjs` owns an HTTP fixture beneath a deployment prefix and mounts the production component. It covers four bounded status reads, Agent relationship filtering, Table/Board switching, all columns and card contents, narrow-viewport overflow containment and fixed detail visibility, detail text and bounded note/child summaries, loading, empty views, errors, Refresh recovery, obsolete detail cancellation, and the create/comment/owner user-action controls.
- `workbenchPreview.e2e.mjs` compares actual Task-page, first-popup and Node badges in Default light/dark, including shared type/dot/tone, compact popup sizing with unchanged page geometry, long-title containment, independent upgrade badges and complete directory scrolling. It also mounts the production built App against its existing mock APIs. It covers Tasks route restoration/reload, New task backdrop interception over Sidebar with retained draft and unchanged route, desktop expanded/collapsed singleton activation and footer layout, independent retained mobile primary navigation, embedded direct popup activation and blocked-popup feedback, popout URL/leaf behavior and sole-tab header close alongside the existing Chat, Agents, History, Logs, Setup, Terminal and Code behaviors.
- Existing workbench normalization and popup URL/parser tests preserve old system tabs while accepting Tasks.

Mobile-specific navigation, headers, and preferences follow the [mobile shell contract](../threads/webui-mobile-shell.md); desktop data and workbench owners remain unchanged.
