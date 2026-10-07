# Unit: WebUI Tasks

Files: packages/webui/src/components/TasksView.tsx, packages/webui/src/components/SessionSelector.tsx, packages/webui/test/tasksView.e2e.mjs
Secondary files: packages/webui/src/App.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/EmbeddedWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/workbench/types.ts, packages/webui/src/workbench/utils.ts, packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/sessionListAndWorkbenchState.test.mjs, packages/webui/test/popupWebUi.test.mjs

## Purpose

Provides a Tasks singleton workbench tab with Table and Board views, manual Refresh, task details, and the three authenticated user actions: create, comment and owner change/release. It observes tasks independently of Session history and does not add realtime subscriptions, card dragging or account/role controls.

## Key exports and function index

| Symbol | Responsibility |
|---|---|
| `TasksView` | Own the selected view, bounded task windows, selected task details, loading/error states and manual refresh |
| `SessionSelector` | Controlled bounded Session search/exact hydration control shared by task creation and owner changes |
| `readTasks` | Read one deployment-relative JSON endpoint with cancellation and an actionable API error |
| `writeTask` | Send deployment-relative JSON user mutations and surface server task errors |
| `formatTime` | Display numeric task timestamps in browser-local time |
| `STATUSES` / `LIST_LIMIT` | Select all four status windows with at most 50 tasks each |

## Data and presentation

- `GET /api/tasks?status=<status>&limit=50` is read once for each of `open`, `active`, `completed`, and `cancelled`. Unfiltered API reads include only unfinished tasks, so the UI selects terminal statuses explicitly too. Table and Board share these four bounded windows (at most 200 tasks), ordered by descending `updatedAt` with ID tie-breaking. Work is the default scope and shows Open/Active, History shows Completed/Cancelled, and All shows all four statuses. Scope status counts describe the actually loaded window; bounded omitted counts remain secondary information instead of the primary summary.
- Table shows title, status, owner Session, creator (`User` or the source Session), and update time. Table and Board use compact Session references with readable agent/leaf labels plus copy and optional navigation actions; full Session IDs remain in titles and the detail panel. Session columns keep readable minimum widths and do not break identifiers character-by-character; the table scrolls inside the Tasks content area when needed. Board renders the two columns for Work or History and four columns for All with title, task ID, owner and update time on each card; it does not offer card dragging.
- The header provides bounded client-side Agent filtering over the loaded windows. The Agent dropdown uses nullable `ownerAgent`/`createdByAgent` metadata resolved from the existing Session catalog, and a separate relationship selector explicitly chooses Owner, Created by, or Owner or Created by matching; it never infers an Agent from a Session ID string. Filtered results remain within the same bounded list contract and report hidden/not-loaded counts.
- Clicking a title or card reads `GET /api/tasks/:id`. The detail response is `{ task, children, childrenOmitted, notes, notesOmitted }`; the panel shows description, immutable parent ID, owner, result, bounded children and notes. Note authors display `User` or the canonical Session ID from the explicit author projection. A child title selects that child's details. Text is rendered as React text, not HTML. On narrow viewports, selected details use a fixed full-screen dialog so they are immediately visible instead of being placed after a long list and can be closed with the existing close control; desktop keeps the side-panel layout without modal semantics.
- `New task` opens a controlled form for title, description, optional owner Session and notification. The owner selector remembers the last successfully submitted owner in Tasks-local browser storage; failed or cancelled submissions do not change that default. Creation is a User action and never sends a selected Session as the creator.
- Task details provide a controlled owner selector with release, notification checkbox, and save action, plus a User comment form that may notify the current owner. Comments remain allowed for completed/cancelled tasks; owner changes follow the server terminal-state rule. User mutations refresh the selected detail/list after success and display delivery warnings/errors without pretending the selected Session authored the action.
- `SessionSelector` searches `/api/session-list/search` through bounded catalog projections, hydrates a selected ID through `/api/session-list/by-id`, shows real Agent metadata and canonical IDs, and uses latest-request cancellation. It is independent of the Sidebar tree and contains no authorization or account semantics.
- Each list/detail effect cancels its previous request on refresh, selection change or unmount. An obsolete response cannot publish state. Refresh rereads both the bounded list and the selected detail. Loading, empty and failure states remain visible and a later Refresh retries failed reads.
- URLs use `makeApiUrl`, including encoded detail IDs, preserving deployment prefixes. No task or note is copied into Chat history.

## Workbench integration

`system:tasks` uses the existing singleton activation, hash restoration, storage normalization, close fallback, split panes, tab menus and top-level popup flow. The settings menu exposes `Tasks` in expanded, collapsed and mobile navigation. Code's embedded Sidebar opens the same-origin Tasks popup without adding a host bridge or embedded target kind. The sole-tab header uses the ordinary workbench icon/Close controls; popup leaves have no workbench controls.

## Design decisions

### D-webui-tasks-user-actions

[2026-10-07] Tasks is a singleton workbench tab offering Table, Board, task details, manual Refresh, and only create/comment/owner user actions. User author identity is distinct from owner Session identity; no selected Session is used as the User actor. The UI adds no claim/complete/cancel controls, card dragging, account/role platform or task-specific realtime transport. Ordinary authenticated WebUI access retains its existing full-access contract.

## Tests

- `tasksView.e2e.mjs` owns an HTTP fixture beneath a deployment prefix and mounts the production component. It covers four bounded status reads, Agent relationship filtering, Table/Board switching, all columns and card contents, narrow-viewport overflow containment and fixed detail visibility, detail text and bounded note/child summaries, loading, empty views, errors, Refresh recovery, obsolete detail cancellation, and the create/comment/owner user-action controls.
- `workbenchPreview.e2e.mjs` mounts the production built App against its existing mock APIs. It covers Tasks route restoration/reload, singleton menu activation, popout URL/leaf behavior and sole-tab header close alongside the existing Chat, Agents, History, Logs, Setup, Terminal and Code behaviors.
- Existing workbench normalization and popup URL/parser tests preserve old system tabs while accepting Tasks.
