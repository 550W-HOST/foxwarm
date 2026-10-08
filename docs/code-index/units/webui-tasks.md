# Unit: Task and collaboration UI

Files: `packages/webui/src/components/TasksView.tsx`

## Purpose

Renders the task authority view exposed by the host task routes, including authenticated user create/comment/assign controls.

## Stable symbols and callers

`TasksView`; task row/assignment/notification rendering; authenticated task mutations; agent catalog filters.

Callers and boundary: `WebUIChannel.Tasks`; task service payloads; explicit user refresh.

## Behavior and side effects

`TasksView` renders current task authority in Table and Board views, opens bounded task details, provides manual refresh plus client-side Agent/relationship filters, and sends user-owned create/comment/assign operations through the user task routes. It displays nullable user/session provenance without manufacturing child-handoff receipts or treating a task operation as a model-turn completion.

## Tests

Task view and session-task integration tests.
