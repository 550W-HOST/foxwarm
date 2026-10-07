# Unit: WebUI tasks, relations, and architecture actions

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Presentation.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Relations.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Tasks.cs`

## Purpose

Exposes Session relation/tree operations and current task authority/service APIs to TasksView, architecture panels, and notification/realtime consumers.

## Stable methods and callers

Relations delegate bounded parent/child/agent/tree queries to `SessionCatalog`/`SessionManager`; they do not infer semantic history from catalog rows. Tasks parse `TaskService` operations, owner/assignee/status/result/notification fields, and current anchor/progress data; service returns accepted/committed/error payloads and emits notifications.

## Contract and side effects

Task UI/API work is implemented, while child task-id attachment, handoff receipts, legacy Goal migration, and request-local reminder consumers remain absent. Ordinary Session queue acceptance retains best-effort semantics. Relation mutations use Main identity/topology ownership and cannot bypass Session deletion/identity gates.

## Tests

`WebUiRealtimeRevisionTests.cs`; `SessionCatalogTests.cs`; `TaskStoreTests.cs`; catalog relation/query tests.
