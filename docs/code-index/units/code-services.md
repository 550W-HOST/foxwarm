# Unit: Code workbench and Git/file services

Files: `dotnet/Foxwarm/Code/CodeFileService.cs`, `dotnet/Foxwarm/Code/CodeGitService.Commit.cs`, `dotnet/Foxwarm/Code/CodeGitService.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.Routes.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.cs`

## Purpose

Serves source files and Git metadata through the Code workbench boundary, including optional VS Code Web capability requests.

## Stable symbols and callers

`CodeWorkbench.Register`; `CodeFileService`; `CodeGitService`.

Callers and adjacent boundaries: HttpServer; WebUI workbench components; TerminalRegistry.

## Local and remote consumers

`CodeWorkbench` keeps the existing deployment-relative workbench, static assets, capability URLs, persistent multi-root workspace and browser bridge. Filesystem routes select Master-local `CodeFileService` or the captured Node's advertised `vscode-fs` operations. Write/read retain the inclusive 50 MiB file boundary; oversized requests reject before dispatch. Remote binary content crosses the official base64 service envelope, not an exec command or ordinary model tool.

Status/content select local `CodeGitService` or `vscode-git`; commit details require service version 2 and retain immutable commit IDs and bounded content. The HTTP response stamps the requested authenticated Node namespace for Git consumers rather than accepting a peer-supplied identity. SCM remains read-only. Absolute POSIX paths and `foxwarm://node+<id>/...` preserve the concrete remote namespace; earlier URI readers remain available. Native Windows Code workspace mapping is not added.

The fixed workspace-root response remains Master-only and authoritative for app/data/config commands, independent of Session-selected Node/cwd. Normal instance-token authentication remains distinct from capability and exact browser bridge checks; there is no generic Origin URL gate or fabricated model caller. [Code integration](../threads/code-integration.md) owns these shared contracts.

## Tests

`dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs`; `NodeServiceTransportTests.cs`; `packages/webui/test/experimentHostNodeCode.e2e.mjs` (owned hosts, unchanged official CLI, original WebUI and optional official workbench/browser extensions).
