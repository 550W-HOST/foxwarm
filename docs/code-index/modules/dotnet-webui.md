# Module: WebUI channel

The .NET HTTP/WebSocket surface consumed by the React WebUI. `HttpServer` owns auth/static/prefix composition; these partial route units own DTO validation and delegation to Session/task/image/Code/terminal services.

## Units

- [Shared access identities and scoped WebUI](../units/dotnet-access-identities.md)
- [WebUI channel registration and shared DTO contract](../units/dotnet-webui-core.md)
- [WebUI history, Session list, and bounded replay routes](../units/dotnet-webui-history-list.md)
- [WebUI files, images, and uploads](../units/dotnet-webui-files-images.md)
- [WebUI tasks, relations, and architecture actions](../units/dotnet-webui-tasks-relations.md)
- [WebUI Agent, setup, and model configuration routes](../units/dotnet-webui-agents-setup.md)
- [WebUI deletion and terminal routes](../units/dotnet-webui-lifecycle-terminal.md)
- [WebUI realtime event publisher](../units/dotnet-webui-realtime.md)

## Cross-module contracts

- [.NET WebUI boundary](../threads/dotnet-webui-boundary.md)
- [Session ownership and persistence](../threads/session-ownership-and-persistence.md)
- [Tasks, timers, waits, and notifications](../threads/tasks-timers-and-waits.md)
