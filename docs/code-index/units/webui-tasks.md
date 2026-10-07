# Unit: Task and collaboration UI

Files: `packages/webui/src/components/TasksView.tsx`

## Purpose

Renders task authority, ownership, notification, and collaboration controls exposed by the host task routes.

## Stable symbols and callers

`TasksView`; task row/assignment/notification rendering.

Callers and boundary: `WebUIChannel.Tasks`; task service payloads; WebUI realtime refresh.

## Behavior and side effects

`TasksView` renders current task authority, owner/assignee/status/result/notification fields and invokes explicit task CRUD/claim/assign/complete controls. It displays accepted/committed/error responses and realtime refreshes; it does not manufacture child-handoff receipts or treat a task operation as a model-turn completion.

## Tests

Task view and session-task integration tests.
