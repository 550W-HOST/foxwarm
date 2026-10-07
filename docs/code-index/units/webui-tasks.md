# Unit: WebUI Tasks

Files: packages/webui/src/components/TasksView.tsx, packages/webui/test/tasksView.e2e.mjs
Secondary files: packages/webui/src/App.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/EmbeddedWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/workbench/types.ts, packages/webui/src/workbench/utils.ts, packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/sessionListAndWorkbenchState.test.mjs, packages/webui/test/popupWebUi.test.mjs

## Purpose

Provides a read-only Tasks singleton workbench tab with Table and Board views, manual Refresh, and a task detail panel. It observes tasks independently of Session history and does not add realtime subscriptions or task write controls.

## Key exports and function index

| Symbol | Responsibility |
|---|---|
| `TasksView` | Own the selected view, bounded task windows, selected task details, loading/error states and manual refresh |
| `readTasks` | Read one deployment-relative JSON endpoint with cancellation and an actionable API error |
| `formatTime` | Display numeric task timestamps in browser-local time |
| `STATUSES` / `LIST_LIMIT` | Select all four status windows with at most 50 tasks each |

## Data and presentation

- `GET /api/tasks?status=<status>&limit=50` is read once for each of `open`, `active`, `completed`, and `cancelled`. Unfiltered API reads include only unfinished tasks, so the UI selects terminal statuses explicitly too. Table and Board share these four bounded windows (at most 200 tasks), ordered by descending `updatedAt` with ID tie-breaking. Omitted counts are summed and shown without an unbounded follow-up query.
- Table shows title, status, owner Session, creating Session, and update time. Session columns keep readable minimum widths and do not break identifiers character-by-character; the table scrolls inside the Tasks content area when needed. Board has four fixed columns with title, task ID, owner and update time on each card; it does not offer card dragging.
- The header provides bounded client-side Agent filtering over the loaded windows. The Agent dropdown derives agent IDs from owner and creator Session IDs, and a separate relationship selector explicitly chooses Owner, Created by, or Owner or Created by matching. Filtered results remain within the same bounded list contract and report hidden/not-loaded counts.
- Clicking a title or card reads `GET /api/tasks/:id`. The detail response is `{ task, children, childrenOmitted, notes, notesOmitted }`; the panel shows description, immutable parent ID, owner, result, bounded children and notes. A child title selects that child's details. Text is rendered as React text, not HTML. On narrow viewports, selected details use a fixed full-screen panel so they are immediately visible instead of being placed after a long list; desktop keeps the side-panel layout.
- Each list/detail effect cancels its previous request on refresh, selection change or unmount. An obsolete response cannot publish state. Refresh rereads both the bounded list and the selected detail. Loading, empty and failure states remain visible and a later Refresh retries failed reads.
- URLs use `makeApiUrl`, including encoded detail IDs, preserving deployment prefixes. No task or note is copied into Chat history.

## Workbench integration

`system:tasks` uses the existing singleton activation, hash restoration, storage normalization, close fallback, split panes, tab menus and top-level popup flow. The settings menu exposes `Tasks` in expanded, collapsed and mobile navigation. Code's embedded Sidebar opens the same-origin Tasks popup without adding a host bridge or embedded target kind. The sole-tab header uses the ordinary workbench icon/Close controls; popup leaves have no workbench controls.

## Design decisions

### D-webui-tasks-read-only-views

[2026-10-06] Tasks is a singleton workbench tab offering Table, Board, task details and manual Refresh. The first UI is for observing bounded task state: it adds no create, assign, claim, complete or cancel controls, no card dragging, no identity restrictions and no task-specific realtime transport. Ordinary authenticated WebUI access retains its existing full-access contract.

## Tests

- `tasksView.e2e.mjs` owns an HTTP fixture beneath a deployment prefix and mounts the production component. It covers four bounded status reads, Agent relationship filtering, Table/Board switching, all columns and card contents, narrow-viewport overflow containment and fixed detail visibility, detail text and bounded note/child summaries, loading, empty views, errors, Refresh recovery, and obsolete detail cancellation.
- `workbenchPreview.e2e.mjs` mounts the production built App against its existing mock APIs. It covers Tasks route restoration/reload, singleton menu activation, popout URL/leaf behavior and sole-tab header close alongside the existing Chat, Agents, History, Logs, Setup, Terminal and Code behaviors.
- Existing workbench normalization and popup URL/parser tests preserve old system tabs while accepting Tasks.
