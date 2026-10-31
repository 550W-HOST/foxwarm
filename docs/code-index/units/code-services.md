# Unit: Code workbench and Git/file services

Files: `dotnet/Foxwarm/Code/CodeFileService.cs`, `dotnet/Foxwarm/Code/CodeNativePaths.cs`, `dotnet/Foxwarm/Code/CodeGitService.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.Routes.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.cs`

## Purpose

Serves source files and Git metadata through the Code workbench boundary, including optional VS Code Web capability requests.

## Stable symbols and callers

`CodeWorkbench.Register`, `DownloadAsync`, `PatchWorkbench`, `PatchPre`; `CodeFileService`; `CodeGitService`. Native file/Git mechanisms now live in [shared primitives](./dotnet-node-primitives.md); these wrappers retain Main path/URI adaptation, unavailable-Git presentation and authenticated HTTP ownership.

Callers and adjacent boundaries: HttpServer; WebUI workbench components; TerminalRegistry.

## Local and remote consumers

`CodeWorkbench` keeps the existing deployment-relative workbench, static assets, capability URLs, persistent multi-root workspace and browser bridge. Filesystem routes select Master-local `CodeFileService` or the captured Node's advertised `vscode-fs` operations. Write/read retain the inclusive 50 MiB file boundary; oversized requests reject before dispatch. Remote binary content crosses the official base64 service envelope, not an exec command or ordinary model tool.

The read-file HTTP route is registered by the [MCP download boundary](./dotnet-inbound-mcp.md#stateless-remote-file-download), which delegates existing administrator requests to `CodeWorkbench.DownloadAsync`. Its independent external identity checks do not authorize the other Code APIs. `NodeConnectionHub.RequestServiceAsync` accepts a final caller assertion at the existing exact-connection send gate; ordinary Code callers keep their current path.

Status/content select local `CodeGitService` or `vscode-git`; commit details require service version 2 and retain immutable commit IDs and bounded content. The HTTP response stamps the requested authenticated Node namespace for Git consumers rather than accepting a peer-supplied identity. SCM remains read-only. Local Main content normalizes the path, checks its workspace child and validates the content ref before side dispatch, including working content. The shared Node service applies the child check only to working reads and ignores their refs, so literal `..`-prefixed base names are service-only. Absolute POSIX paths and `foxwarm://node+<id>/...` preserve the concrete remote namespace; earlier URI readers remain available. Windows Main maps absolute drive paths at the [Code URI boundary](../threads/code-integration.md#d-code-real-path-uri); local filesystem/Git calls receive native paths while remote payloads retain their existing POSIX semantics. `CodeNativePaths.Native`/`Transport` own that mapping. Windows stat uses native file metadata/link resolution and rename uses MoveFileEx without cross-volume copy or rollback. Typed bootstrap URI components retain escaped path segments for the official URI readers' single decode, including literal percent sequences, drive colons, spaces and Unicode. Git remains an optional external executable and missing Git reports unavailable rather than borrowing a shell implementation.

The fixed workspace-root response remains Master-only and authoritative for app/data/config commands, independent of Session-selected Node/cwd. Normal instance-token authentication remains distinct from capability and exact browser bridge checks; there is no generic Origin URL gate or fabricated model caller. [Code integration](../threads/code-integration.md) owns these shared contracts.

## Installed resources and workspace defaults

Code workbench assets use `<resource-root>/packages/vscode-web/assets/vscode-web`; optional Red Hat YAML assets use `<resource-root>/packages/vscode-web/assets/extensions/redhat.vscode-yaml`. The resource root is the executable payload, independently of the selected application/data roots. Deployments may mount existing prepared assets at those locations. Build tools retain their existing CLI output arguments and defaults, without runtime asset environment controls.

Direct launches without a folder request open the application root. Embedded launches retain selected `state/vscode-web/foxwarm.code-workspace`; persisted folders, explicit settings and malformed files keep their existing behavior. Managed webviews retain the same-public-origin process capability. Source retains its automatic hashed localhost origin and same-origin capability fallback elsewhere. No configured-origin, default-folder or workspace-path environment branch participates.

## Project workspace identities

An embedded bootstrap with `workspaceId` requires an explicit initial folder and a bounded filesystem-safe ID. It uses `state/vscode-web/project-workspaces/<id>.code-workspace` and a matching `.target.json` initial-folder binding, independently from the classic workspace. Reusing an ID with a different initial Node/folder rejects; ordinary settings/folders inside the descriptor retain the existing Code persistence behavior. The shared Project shell supplies its work-session ID, starts the iframe on first visibility and retains it across navigation. Closing the Code tab destroys that iframe; reopening the same work session reuses its persisted descriptor. The ID is browser workspace identity, not a new filesystem authorization boundary.

## Asset adaptation and version evidence

The authenticated static route adapts only `out/vs/workbench/workbench.web.main.internal.js` from the installed optional asset directory. `PatchWorkbench` matches the Source-supported webview-origin hash helper and clipboard-probe bodies, capturing current generated identifiers rather than pinning minifier names. Only the first supported helper/probe is rewritten; changed shapes fail with an explicit unavailable response. The original asset file is not modified. Capability bootstrap/CSP rewriting, normal auth and deployment-relative URLs keep their existing owners.

The source preparation pin is Code-OSS 1.141.0; route-shape tests do not prove a prepared or running asset version. The owned normal-host Workbench fixture has qualified the pinned source-built 1.141.0 payload for filesystem saves, immutable SCM content/diff rendering, local terminal extension effects, embedded iframe reuse and standalone launch. This does not qualify every optional workbench feature. Optional YAML assistance requires its separately prepared vendor payload and its own browser qualification; neither asset preparation nor route registration establishes that behavior.

## Tests

`dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs` (real served files/Git, native metadata/link/error/partial-rename behavior, missing Git, renamed asset identifiers, unchanged source bytes and auth); `packages/webui/test/mainHostWorkbenchParity.e2e.mjs` (normal host/original App, optional official Code-OSS FS/SCM/PTY extensions, exact immutable Git content status/body and rendered diff within one 30-second bound rather than treating the mounted editor shell as loaded content); `NodeServiceTransportTests.cs`; `packages/webui/test/mainHostNodeCode.e2e.mjs` (owned hosts, unchanged official CLI, original WebUI and optional official workbench/browser extensions).

`packages/webui/test/dotnetCliNodeCodeMain.e2e.mjs` exercises the .NET CLI with normal Source/.NET Main, original App and prepared official FS/SCM extensions, without claiming remote PTY support.

The remote-workspace data-folder command in `mainHostNodeCode.e2e.mjs` observes the successful Master write for the exact workspace file before reading it and asserting the authoritative data root. Keyboard dispatch alone does not settle that asynchronous write.
