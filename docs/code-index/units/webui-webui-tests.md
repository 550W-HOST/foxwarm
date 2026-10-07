# Unit: React WebUI tests and fixtures

Files: `packages/webui/test`

## Purpose

Covers browser rendering, host-route DTO/realtime behavior, session list/replay, chat/composer/timeline, TasksView, terminal, Code/workbench, setup, and theme integration.

## Stable navigation

Use the test filename/fixture domain to locate the paired `packages/webui/src` unit, then follow the .NET route unit for the host-side producer and durable contract. Browser tests may assert optimistic/realtime behavior but cannot establish Session authority by themselves.

## Boundary behavior

Fixtures keep deployment-relative URLs, auth/session identity, cursor/revision, and event ordering explicit. A UI-only pass does not prove a .NET route is integrated into the root launcher or that remote Node/Vector features are available.

## Tests

Run with the WebUI package test script; this index task only runs `npm run quality:code-index` and documentation whitespace checks.
