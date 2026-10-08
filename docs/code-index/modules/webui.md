# Module: React WebUI

The browser client built from `packages/webui`. It renders session navigation, Chat, history and realtime state, tasks, setup, logs, terminal, and Code workbench surfaces against the host route contract. Browser state is presentation state; Session authority and durable task state remain host-owned.

## Units

- [Chat composer](../units/webui-chat-composer.md)
- [Chat timeline](../units/webui-chat-timeline.md)
- [Chat realtime transport](../units/webui-realtime.md)
- [History search](../units/webui-history-search.md)
- [Logs view](../units/webui-logs.md)
- [Tasks view](../units/webui-tasks.md)
- [Terminal view](../units/webui-terminal.md)
- [Workbench and tab layout](../units/webui-workbench.md)

## Boundaries

- The .NET host owns authentication, route authorization, Session authority, task persistence, and realtime event ordering. See [the .NET WebUI module](./dotnet-webui.md).
- The browser derives API, WebSocket, popup, download, and Code URLs from the active deployment path and origin; site-root assumptions are invalid.
- Chat history, queue state, task state, and settings shown in the browser are refreshed from host responses and realtime events rather than treated as independent authority.
- Built-in and imported theme data follows one browser-local manifest/runtime path; rendering remains presentation-only.

## Compatibility

- Supported legacy message and workbench forms are normalized on read where the current WebUI still exposes that compatibility boundary.
- Optional Code assets remain outside the main WebUI bundle.
