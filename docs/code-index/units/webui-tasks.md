# Unit: .NET WebUI Tasks

Files: `packages/webui/src/components/TasksView.tsx`, `packages/webui/test/tasksView.e2e.mjs`

Secondary files: `packages/webui/src/App.tsx`, `packages/webui/src/PopupWebUiApp.tsx`, `packages/webui/src/EmbeddedWebUiApp.tsx`, `packages/webui/src/workbench/types.ts`, `packages/webui/src/workbench/utils.ts`

## Purpose

Provides the read-only Tasks singleton workbench surface. It observes task state without adding task write controls, realtime subscriptions, card dragging or ownership roles.

## Behavior

`TasksView` reads four deployment-relative bounded status windows (`open`, `active`, `completed`, and `cancelled`) with a limit of 50 each, merges them by update time, and reports omitted rows. Table and Board views show the bounded task summaries. Selecting a row or card reads one bounded detail response containing the task, up to 20 children and up to 10 notes with omission counts. Description, result, parent, owner, creator, timestamps, child links and notes are rendered as text.

List and detail requests use `AbortController`; refresh, selection changes and unmount cancel stale requests. Loading, empty and error states remain visible and a manual Refresh retries the current windows. URLs use the existing `makeApiUrl` helper so reverse-proxy deployment prefixes remain intact.

The existing App, Sidebar, Workbench, popup and Code-sidebar routing keeps Tasks as one singleton tab (`system:tasks`). No task data is copied into Chat history and no separate browser authority is introduced.
