# Unit: Code workbench and Git/file services

Files: `dotnet/Foxwarm/Code/CodeFileService.cs`, `dotnet/Foxwarm/Code/CodeNativePaths.cs`, `dotnet/Foxwarm/Code/CodeGitService.Commit.cs`, `dotnet/Foxwarm/Code/CodeGitService.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.Routes.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.cs`

## Purpose

Serves source files and Git metadata through the Code workbench boundary, including optional VS Code Web capability requests.

## Stable symbols and callers

`CodeWorkbench.Register`, `PatchWorkbench`, `PatchPre`; `CodeFileService`; `CodeGitService`.

Callers and adjacent boundaries: HttpServer; WebUI workbench components; TerminalRegistry.

## Local and remote consumers

`CodeWorkbench` keeps the existing deployment-relative workbench, static assets, capability URLs, persistent multi-root workspace and browser bridge. Filesystem routes select Master-local `CodeFileService` or the captured Node's advertised `vscode-fs` operations. Write/read retain the inclusive 50 MiB file boundary; oversized requests reject before dispatch. Remote binary content crosses the official base64 service envelope, not an exec command or ordinary model tool.

Status/content select local `CodeGitService` or `vscode-git`; commit details require service version 2 and retain immutable commit IDs and bounded content. The HTTP response stamps the requested authenticated Node namespace for Git consumers rather than accepting a peer-supplied identity. SCM remains read-only. Absolute POSIX paths and `foxwarm://node+<id>/...` preserve the concrete remote namespace; earlier URI readers remain available. Windows Main maps absolute drive paths at the [Code URI boundary](../threads/code-integration.md#d-code-real-path-uri); local filesystem/Git calls receive native paths while remote payloads retain their existing POSIX semantics. `CodeNativePaths.Native`/`Transport` own that mapping. Windows stat uses native file metadata/link resolution and rename uses MoveFileEx without cross-volume copy or rollback. Typed bootstrap URI components decode escaped path segments, including drive colons, spaces and Unicode. Git remains an optional external executable and missing Git reports unavailable rather than borrowing a shell implementation.

The fixed workspace-root response remains Master-only and authoritative for app/data/config commands, independent of Session-selected Node/cwd. Normal instance-token authentication remains distinct from capability and exact browser bridge checks; there is no generic Origin URL gate or fabricated model caller. [Code integration](../threads/code-integration.md) owns these shared contracts.

## Asset adaptation and version evidence

The authenticated static route adapts only `out/vs/workbench/workbench.web.main.internal.js` from the configured optional asset directory. `PatchWorkbench` matches the Source-supported webview-origin hash helper and clipboard-probe bodies, capturing current generated identifiers rather than pinning minifier names. Only the first supported helper/probe is rewritten; changed shapes fail with an explicit unavailable response. The original asset file is not modified. Capability bootstrap/CSP rewriting, normal auth and deployment-relative URLs keep their existing owners.

The source preparation pin is Code-OSS 1.141.0; route-shape tests do not prove a prepared or running asset version. The owned original-App browser fixture has qualified the existing separately prepared Code-OSS 1.128.0 payload. Newer Code-OSS assets require their own preparation and browser/extension qualification. Optional YAML assistance requires its separately prepared vendor payload and is not inferred from route registration.

## Tests

`dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs` (real served route, renamed identifiers, incompatible shapes, unchanged source bytes and auth); `packages/webui/test/experimentHostWorkbenchParity.e2e.mjs` (normal host/original App, optional official Code-OSS FS/SCM/PTY extensions); `NodeServiceTransportTests.cs`; `packages/webui/test/experimentHostNodeCode.e2e.mjs` (owned hosts, unchanged official CLI, original WebUI and optional official workbench/browser extensions).
