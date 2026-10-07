# Module: React WebUI

The browser client built from `packages/webui`. It renders sessions, streams, tools, tasks, settings, terminal, and Code workbench surfaces against the .NET host route contract. Browser state is not Session authority: committed history/queue/settings come from host responses and realtime events.

## Units

- [Application shell, embedding, and transport configuration](../units/webui-app-shell.md)
- [Chat composer, attachments, and session draft state](../units/webui-chat-composer.md)
- [Chat timeline, message rendering, and tool cards](../units/webui-chat-timeline.md)
- [Session list, architecture, search, and bounded replay](../units/webui-session-navigation.md)
- [Task and collaboration UI](../units/webui-tasks.md)
- [Workbench, Code launch, and VS Code Web frame](../units/webui-workbench.md)
- [Terminal view and virtual keyboard](../units/webui-terminal.md)
- [Setup, model configuration, and UI settings](../units/webui-settings-setup.md)
- [Theme system and built-in themes](../units/webui-theme.md)
- [Realtime transport and event timing](../units/webui-realtime.md)
- [Browser/client tests and fixtures](../units/webui-webui-tests.md)

## Boundary threads

- [.NET WebUI boundary](../threads/dotnet-webui-boundary.md) owns host-side auth/routes/realtime ordering.
- [Session ownership and persistence](../threads/session-ownership-and-persistence.md) owns which host response is authoritative.
