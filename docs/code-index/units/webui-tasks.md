# Unit: Task and collaboration UI

Files: `packages/webui/src/components/TasksView.tsx`

## Purpose

Renders the read-only task authority view exposed by the host task routes.

## Stable symbols and callers

`TasksView`; task row/assignment/notification rendering; agent catalog filters.

Callers and boundary: `WebUIChannel.Tasks`; task service payloads; explicit user refresh.

## Behavior and side effects

`TasksView` renders current task authority in Table and Board views, opens bounded task details, and provides manual refresh plus client-side Agent/relationship filters. Authenticated list rows may include nullable catalog-derived creator/owner Agent labels, which the view filters client-side without changing task mutation payloads. The view does not provide task mutation controls, manufacture child-handoff receipts, or treat a task operation as a model-turn completion.

## Tests

Task view and session-task integration tests.
