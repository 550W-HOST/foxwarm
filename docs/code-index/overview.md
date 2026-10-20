# Foxwarm Code Index

This is the entry point for the project map and repository-specific index conventions. The `code-index` skill (`skills/code-index/SKILL.md`) describes the general reading and maintenance method.

## Reading and changing the code

- Start with the entry relevant to the task. Use this overview for unfamiliar architecture; familiar work may start at a module, thread, or unit without traversing every layer.
- Identify the governing contracts and their rationale before choosing an implementation. Confirmed design decisions and supported compatibility contracts constrain changes; source and tests show actual behavior. Report a discrepancy rather than rewriting a contract to match an accidental implementation.
- For translation or replacement, trace the relevant original caller path from entry to observable effects and compare it with the new path. Index summaries and tests written only for the new implementation do not establish parity.
- Put important constraints and their rationale near the beginning of their owning page, before implementation detail. Each decision has one canonical owner; other pages provide a short summary and link. Unconfirmed proposals belong in `Open Questions`, not among effective decisions.

## Overview

Foxwarm is an AI agent system with a .NET Main host, browser WebUI, model adapters, durable Session state, local tools, optional remote Nodes, and compatibility packages that are still being retired or replaced. The .NET solution is the active Main architecture being developed in this branch. The intended end state is a .NET Main with the existing platform packages connected to its public contracts; the repository still contains TypeScript Main source, retained TypeScript CLI/reference build entries, and remote-platform implementations, so this index does not describe those components as deleted, fully integrated, or publicly promoted. Existing package/npm/tmux/Windows source Main entries now select the managed host; see [source startup](./units/source-main-entry.md) and [public Docker delivery](./units/public-main-docker.md) for the candidate boundaries.

## Start here

1. `dotnet/Foxwarm/Program.cs` starts the local host and composes configuration, Sessions, terminals, routing, HTTP, and WebUI.
2. [Session ownership](./threads/session-ownership-and-persistence.md) traces the normal ingress-to-JSON/Archive/catalog path and its failure classes.
3. [Session authority](./units/session-authority-json.md), [save lane](./units/session-save-lane-core.md), and [catalog projection](./units/session-catalog-projection.md) are the first source pages for persistence changes.
4. [Model requests](./threads/model-request-and-streaming.md) covers routing, provider wire formats, streaming, retries, images, and the request journal.
5. [WebUI boundary](./threads/dotnet-webui-boundary.md) traces HTTP authentication, route registration, realtime events, uploads, Code, and PTY access.
6. [Tool dispatch](./threads/tools-permissions-and-exec.md) traces discovery, authorization, local file/exec tools, and the remaining Node boundary.

## .NET solution

`dotnet/Foxwarm.sln` contains five projects: `Foxwarm` (the host executable), `Foxwarm.DevTools` (developer-facing request/journal probes), `Foxwarm.Tests` (xUnit coverage), `Foxwarm.CliNode` (the [headless file-capable client](./units/dotnet-cli-node.md)), and `Foxwarm.NodePrimitives` (the [small Main/CLI algorithm library](./units/dotnet-node-primitives.md)). The optional `dotnet/Foxwarm.Desktop` project hosts the same Main and WebUI in Windows WinForms/WebView2 outside the cross-platform solution. The host targets .NET 10 and embeds/serves selected WebUI and VS Code Web assets through its project file.

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
  Optional Vector indexing/search uses one local or supervised child derived owner;
  ordinary external Node tools, remote exec/completion, whole-file consumers and fixed
  Code/PTY services and exec-only Shell HTTP connect through .NET trust/transport/dispatch;
  Session Worker hosting and managed ToolScript/controllers remain excluded. Executable
  Node registry/files, persistent provider exec and optional lifecycle are connected (see delivery scope below).

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
| [Nodes and executable providers](./modules/dotnet-nodes.md) | Generic executable registry/files, placement, persistent trust, authenticated WebSocket negotiation and ordinary native remote tools. |
| [External channels](./units/dotnet-external-channels.md) | Shared authorization/routing/attachments/delivery and managed Telegram, Matrix, Weixin, WeWork and [QQ Bot](./units/dotnet-qqbot.md) transports; Main TUI and public delivery cutover remain outside the source candidate. |
| [MCP](./modules/dotnet-mcp.md) | Inbound external contexts/catalog, explicit Session notifications/replies, and official outbound SDK configuration, pooling and calls. |

## Remaining repository components

| Component | Current role and status |
|---|---|
| [WebUI timeline](./modules/webui-timeline.md) | Browser rendering modes, pane-local Search, Reasoning presentation, and Activity accounting. |
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

- **Vector boundary:** optional dense/lexical indexing, semantic recall and administrator History use the [derived Vector owner](./units/vector-owner.md) after authoritative migrations/publication. Disabled configuration remains lazy; child failure is unavailable without local fallback. [Source selection](./units/vector-recall.md) reloads Archive and rechecks canonical model scope. Dense rename does not migrate old Lance rows.
- **Qualification boundary:** .NET implements the shared runtime/control, typed-notice and communication producers through its existing exact owners. [The WebUI boundary](./threads/dotnet-webui-boundary.md#runtime-controls-notices-and-communications) maps the concrete consumer paths; a shared frontend build or merge alone does not establish complete feature parity.
- **Intentional exclusions:** the platforms listed in [delivery scope](#d-dotnet-delivery-scope) are not remaining milestones. Ordinary external Nodes, remote exec/completion, file transfer/delivery, fixed Code/PTY services and exec-only Shell HTTP remain supported.
- **Unconfirmed:** which remaining TypeScript Main routes and channel adapters will be retired versus retained as compatibility services after the .NET Main reaches production parity.

## D-dotnet-delivery-scope

[2026-10-19] Session Worker hosting and managed ToolScript/controller execution remain intentional .NET delivery exclusions. Generic executable Node Provider implementation is now in scope: the current implementation connects registry/discovery, qualified placement, file/process primitives, optional provider lifecycle and their consumers through the existing Main authorization and persistent exec owners. Existing authenticated external Node connection, execution and credentials remain supported. The TypeScript compatibility implementations and shared protocols remain real reference/external boundaries. Current implementation ownership is mapped in [Nodes and executable providers](./modules/dotnet-nodes.md).

## Maintaining this index

### Scope and ownership

Keep final text in English and public-safe: no credentials, private deployment details, personal filesystem paths, or agent-private collaboration notes. Compatibility literals from source or persisted data may be quoted when necessary and identified as such.

Use the narrowest owner that covers a contract: a unit for one semantic unit, a module for several units in that subsystem, a thread for a cross-module flow, or this overview for a project-wide principle. Keep the full decision and rationale only there; use stable headings for links. A critical security, data-integrity, persistence, or external-contract invariant may repeat the same short sentence at an execution boundary with its canonical ID and link; rationale stays at the owner.

Distinguish observed behavior from required invariants. Compatibility notes describe retained persisted-data readers or external contracts, including the old shape read and the new shape written. Replace superseded decisions rather than keeping an implementation chronology.

Unit headers declare source ownership:

```text
Files: path/to/primary.ts, path/to/primary.test.ts
Secondary files: package.json, path/to/integration.test.ts
```

Each source file has at most one primary unit owner. Secondary references do not claim ownership; modules and threads link to units rather than declaring file ownership themselves.

### Targeted updates and checks

Update only changed contracts, responsibilities, and navigation. Keep useful entry points and stable-symbol references, not a prose inventory of every helper, branch, or test run. Update a parent or thread when its own boundary or flow changes, not merely because a child changed.

Remove stale, repeated, or incidental detail before splitting a page by responsibility. Preserve effective contracts and useful rationale; Git history retains superseded material. Do not regenerate the whole index for a local change.

Run from the repository root:

```bash
npm run quality:code-index
```

The audit checks links, primary file existence and ownership, public-safety patterns, English-only text, decision density, and likely duplicated decisions. Review warnings and resolve errors. Files above 24 KiB produce a size warning; files above 48 KiB produce an error. These are structural checks, not evidence of behavioral correctness or translation parity. The audit's own tests run with `npm run test:code-index-audit`.
