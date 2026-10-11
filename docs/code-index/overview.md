# Overview

Foxwarm is an AI agent system with a .NET Main host, browser WebUI, model adapters, durable Session state, local tools, optional remote Nodes, and compatibility packages that are still being retired or replaced. The .NET solution is the active Main architecture being developed in this branch. The intended end state is a .NET Main with the existing platform packages connected to its public contracts; the repository still contains TypeScript Main source, root TypeScript CLI/build/start entries, and remote-platform implementations, so this index does not describe those components as deleted, fully integrated, or already switched over.

## Start here

1. `dotnet/Foxwarm/Program.cs` starts the local host and composes configuration, Sessions, terminals, routing, HTTP, and WebUI.
2. [Session ownership](./threads/session-ownership-and-persistence.md) traces the normal ingress-to-JSON/Archive/catalog path and its failure classes.
3. [Session authority](./units/session-authority-json.md), [save lane](./units/session-save-lane-core.md), and [catalog projection](./units/session-catalog-projection.md) are the first source pages for persistence changes.
4. [Model requests](./threads/model-request-and-streaming.md) covers routing, provider wire formats, streaming, retries, images, and the request journal.
5. [WebUI boundary](./threads/dotnet-webui-boundary.md) traces HTTP authentication, route registration, realtime events, uploads, Code, and PTY access.
6. [Tool dispatch](./threads/tools-permissions-and-exec.md) traces discovery, authorization, local file/exec tools, and the remaining Node boundary.

## .NET solution

`dotnet/Foxwarm.sln` contains three projects: `Foxwarm` (the host executable), `Foxwarm.DevTools` (developer-facing request/journal probes), and `Foxwarm.Tests` (xUnit coverage of the host contracts). The host targets .NET 10 and embeds/serves selected WebUI and VS Code Web assets through its project file.

## Runtime shape

```text
packages/webui (React/Vite assets)
             |
             v
.NET HttpServer -> WebUIChannel / Code / Terminal routes
             |
             v
MessageRouter -> SessionRuntime -> SessionOwner / SessionTurnRunner
                                  |             |
                                  |             +-- model routing, provider clients, retries, journal
                                  |             +-- unified tools, authorization, ToolScript, MCP
                                  |             +-- compaction, Archive, Agent memory
                                  `-- Session catalog and authority persistence

Current integration boundaries:
  Vector-backed admission/search remains disabled or unsupported in the .NET host;
  ordinary external Node tools, remote exec/completion and whole-file consumers connect
  through .NET trust/transport/dispatch; Code/PTY services, Shell HTTP and Worker
  ownership remain separate boundaries.

Optional remote and compatibility components:
  CLI Node, browser extension, Android Node, sandbox runtime, VS Code Web assets,
  shared TypeScript protocols/utilities, and the older TypeScript Main source tree.
```

## Project-wide contracts

- **Serialized Session ownership:** one Session owner controls turn admission, mutable history, and save ordering; callers use runtime/manager APIs rather than mutating persisted authority directly.
- **Split authority boundary:** the per-Session JSON authority owns active `history`, queue, wait, busy/stopping, settings, and related semantic state; Main-owned catalog SQLite owns identity, topology, aliases, presentation, and bounded runtime summaries. Catalog summaries do not replace JSON history/queue authority.
- **Immutable Archive boundary:** Archive rows and lineage are durable audit/context records written through ordered save paths; missing active JSON is an integrity error, not a reason to rebuild Session history from Archive.
- **Archive-to-JSON ordering:** canonical append and compaction write validated Archive rows before the atomic JSON authority publication, roll back only rows inserted by the failed pre-rename attempt, and classify post-rename failures as committed.
- **Normal authentication:** HTTP and WebUI ingress are authenticated by the host before state-changing routes or static application content are served.
- **Model attempt provenance:** concrete model selection, retries, streaming completion, images, and journal records remain attributable to an attempt and its request scope.
- **Tool boundary:** all tool paths resolve through the unified tool registry and authorization evaluation; local capabilities and optional remote Node capabilities are not interchangeable claims.
- **Durable asynchronous state:** waits, timers, compaction, task service state, request journals, and relevant notifications are represented by persisted records or explicit lifecycle APIs where the current implementation supports them.
- **Compatibility is explicit:** TypeScript packages and old persisted readers remain mapped only where they still define a real boundary or migration input.

## .NET modules

| Module | Responsibility |
|---|---|
| [Host and ingress](./modules/dotnet-host.md) | Process startup, configuration, HTTP/auth middleware, message routing, skills, and ASR proxy. |
| [Sessions](./modules/dotnet-sessions.md) | Session identity, ownership, lifecycle, manager operations, catalog, persistence, and turn execution. |
| [Context and memory](./modules/dotnet-context.md) | Canonical messages, compaction, Archive lineage, recall, conditional memory, and Agent knowledge. |
| [Models](./modules/dotnet-models.md) | Configuration, routing, provider adapters, streaming, images, retries, and request journaling. |
| [Tools and permissions](./modules/dotnet-tools.md) | Tool registry, authorization, local file/exec workflows, settings, waits, and MCP-facing tool contracts. |
| [ToolScript](./modules/dotnet-toolscript.md) | Monty execution, host calls, budgets, persistence, and ownership. |
| [WebUI channel](./modules/dotnet-webui.md) | ASP.NET route registration, WebUI DTOs, realtime events, uploads, tasks, relations, history, and terminal access. |
| [Code and terminal](./modules/dotnet-code-terminal.md) | Code workbench/file/Git services, Code helper IPC, and native/managed terminal sessions. |
| [Tasks and timers](./modules/dotnet-tasks-timers.md) | Task authority/service, cron parsing, timer persistence, and scheduling. |
| [Images](./modules/dotnet-images.md) | Blob storage, codecs, transport conversion, provider deduplication, and token estimates. |
| [External Nodes](./modules/dotnet-nodes.md) | Persistent trust, authenticated WebSocket negotiation, placement and ordinary remote tools. |
| [MCP](./modules/dotnet-mcp.md) | Official SDK client connections, configuration, pooling, and outbound server calls. |

## Remaining repository components

| Component | Current role and status |
|---|---|
| [React WebUI](./modules/webui.md) | Current browser client. The .NET host serves its built assets when configured; route and payload compatibility is shared across the boundary. |
| [Shared and Nodes](./modules/shared-and-nodes.md) | TypeScript protocol/utilities plus CLI, browser, Android, and sandbox Node implementations. These remain real execution components while the .NET Main migration proceeds. |
| [TypeScript compatibility source](./modules/typescript-compatibility.md) | Older Main implementation and migration readers. It is not the active .NET architecture, but selected files still explain persisted or external compatibility. |
| [VS Code Web and website](./modules/adjacent-products.md) | Code workbench assets, static site, installer/docs surface, and related build boundaries. |

## Cross-module threads

| Thread | Contract |
|---|---|
| [Session ownership and persistence](./threads/session-ownership-and-persistence.md) | Admission, serialized turns, save lanes, authority documents, catalog publication, restart, fork/clear, and deletion. |
| [Model request and streaming](./threads/model-request-and-streaming.md) | Selection, provider serialization, streaming, retries, image hydration, and journal qualification. |
| [Context archive and compaction](./threads/context-archive-and-compaction.md) | Active history, immutable Archive identity, compaction plans, recall, and conditional memory. |
| [Tools, permissions, and exec](./threads/tools-permissions-and-exec.md) | Discovery, authorization, local tools, bounded output, file delivery, and Node capability boundaries. |
| [ToolScript execution](./threads/toolscript-execution.md) | Script admission, Monty worker lifecycle, host calls, budgets, records, and ownership. |
| [.NET WebUI boundary](./threads/dotnet-webui-boundary.md) | HTTP auth, route contracts, realtime streams, uploads, Code, terminals, and React client integration. |
| [Catalog and indexed queries](./threads/catalog-and-indexed-queries.md) | Main-owned projections, query limits, migrations, and authority boundaries. |
| [Images and attachments](./threads/images-and-attachments.md) | Ingress, canonical blobs, provider forms, transport conversion, and delivery. |
| [Tasks, timers, and waits](./threads/tasks-timers-and-waits.md) | Task service, timer scheduler, Session waits, and UI/API exposure. |
| [Remote Node compatibility](./threads/remote-node-compatibility.md) | Remaining TypeScript Node protocols and the current .NET integration boundary. |

## Current gaps and open questions

- **Current gap:** .NET Vector admission/search is disabled or explicitly unsupported (`WebUIChannel.History` returns `VECTOR_DISABLED`; identity-move/configuration paths do not make Vector a runtime capability). The TypeScript Vector implementation remains a compatibility/reference boundary only.
- **Current gap:** ordinary external Nodes, remote exec/completion and file transfer/delivery are connected. Code/PTY services, Shell HTTP and Worker ownership are not yet connected to the .NET Main owner chain.
- **Unconfirmed:** which remaining TypeScript Main routes and channel adapters will be retired versus retained as compatibility services after the .NET Main reaches production parity.
