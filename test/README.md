# .NET test container

The standard Compose service builds the .NET 10 host and current WebUI from
repository source for Linux x64. It publishes container port 3001 on host port
3003. This is a separate test deployment, not a change to the root TypeScript
launcher or a production migration.

From the repository root, build without replacing the running service:

```sh
docker compose -f test/docker-compose.yml build foxwarm-dotnet-test
```

The image contains the published .NET entry point, native PTY helper, WebUI,
four tracked Code browser-extension bundles, Node setup templates (including
the exec-only Shell client), MCP management skill, and Node source-archive
inputs. Shared JavaScript and CLI Node bundles are built in a Node stage; their
host-generated `dist` directories are not build inputs. Downloaded CLI Node
bootstraps use those bundles and install only their separate target-platform
PTY runtime when available. Node.js is not needed by the Main host image.

ToolScript uses the official pinned Monty 0.0.19 Linux x64 GNU executable at
`/opt/monty/bin/monty`, acquired with the repository's registry-integrity check.
Its package metadata and MIT license are retained under `/opt/monty/share`,
alongside the host's published protocol dependency notices under
`/app/ToolScript`. Build-time Python, compilers and the .NET SDK are not copied
into the runtime image. Git is installed for Main-local read-only Code SCM.
Outbound stdio MCP servers still need their own configured executable and
dependencies; this image does not install arbitrary server runtimes.

Compose preserves `test/state` at `/data/state` and `test/workspace` at
`/workspace`. The administrator token is read from `test/state/token`; there is
no environment token override. Agent directories belong under
`test/workspace/agents`. Configuration and models belong under `test/state`.
Keep these private directories out of Git and the Docker context. Set
`FOXWARM_PUBLIC_BASE_URL` to the reachable published origin and optional mount
when using a proxy or accessing the service from another machine. Binding an
address does not provide TLS or OS isolation.

## Optional Code workbench assets

The large official Code-OSS assets are not downloaded or built by this image.
Prepare a matching asset set using the [workbench package](../packages/vscode-web/README.md),
or copy an already prepared set, including all vendor licenses and notices, to
the ignored `test/.temp/code-assets` directory. Its root must contain `out/`,
`extensions/` and the other files from the prepared workbench. Do not point this
directory at another checkout or an Agent temporary directory.

After the candidate image has been qualified and service replacement is
authorized, start it with a read-only optional asset mount:

```sh
docker compose -f test/docker-compose.yml -f test/docker-compose.code.yml up -d --no-build foxwarm-dotnet-test
```

Without the override, the service can run normally; opening Code reports the
missing optional workbench assets. The override sets
`FOXWARM_VSCODE_WEB_ASSET_DIR=/opt/foxwarm/code-assets`. The optional YAML
contributor has its own asset configuration described in the workbench docs.

## Qualification boundaries

NuGet publish includes the pinned Skia raster dependency. The optional pinned
libheif/libde265 chain is not installed by this image; HEIC/HEIF input remains
unavailable until that separately qualified prerequisite is supplied. See
[image prerequisites](../dotnet/native-image-prerequisites.md).

The image packages the current external Node, Shell HTTP and outbound MCP
implementation. It does not add environment provisioning, Worker execution,
inbound MCP notifications, scoped WebUI identities, external platform channels,
or root-launcher migration. See the [.NET host documentation](../dotnet/README.md)
for the actual connected contracts and remaining limits.
