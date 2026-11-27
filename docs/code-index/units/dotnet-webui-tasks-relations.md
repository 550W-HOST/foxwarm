# Unit: WebUI tasks, relations, and architecture actions

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Presentation.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Relations.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Tasks.cs`

## Purpose

Exposes Session relation/tree operations and current task authority/service APIs to TasksView, architecture panels, and notification/realtime consumers.

## Stable methods and callers

Relations delegate bounded parent/child/agent/tree queries to `SessionCatalog`/`SessionManager`; they do not infer semantic history from catalog rows. Tasks parse `TaskService` operations, owner/assignee/status/result/notification fields, and current anchor/progress data; service returns accepted/committed/error payloads and emits notifications.

## Contract and side effects

Task UI/API work is implemented with task-id child attachment, typed handoff receipts, owner-save legacy Goal migration, and request-local reminder/compaction consumers. Ordinary Session queue acceptance retains best-effort semantics. Relation mutations use Main identity/topology ownership and cannot bypass Session deletion/identity gates.

## WebUI settings (`state/webui.json`)

`Presentation.cs` also serves the installation's WebUI settings, persisted in `state/webui.json` by whole-file replacement under one process-local gate. `instanceName` and `tabIcon` (browser name and tab icon) are written by `POST /api/webui/settings`, which accepts only those two fields.

`sendKeyDefault` (`enter` or `modEnter`) is the send key for browsers that never chose one. [2026-11-26, user decision B-4] Only the first-run models save writes it, as `enter`, under the same "no models file before the save" condition that creates the [first-run default Session](./dotnet-webui-agents-setup.md#first-run-default-session); a failure to record it is logged and does not fail the save. Branding saves keep it, and the settings POST rejects it. A missing field means `modEnter`: installations created before this record keep Ctrl/Cmd+Enter. Responses present that default without writing it. The WebUI side is in [chat composer](./webui-chat-composer.md).

## Tests

`FirstRunWelcomeTests.cs` (send-key default record and its preservation); `WebUiRealtimeRevisionTests.cs`; `SessionCatalogTests.cs`; `TaskStoreTests.cs`; catalog relation/query tests.
