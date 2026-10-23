# Managed Main Docker delivery

The root `Dockerfile` is the single production/test application recipe. Both
root Compose and `test/docker-compose.yml` build it from source. Its qualified
container target is Linux x64; this is a delivery candidate, not public release
promotion or permission to replace a live installation.

## Build and runtime

```sh
# Production candidate, without starting or replacing a service:
docker compose build foxwarm
# Test consumer, using the same recipe:
docker compose -f test/docker-compose.yml build foxwarm-dotnet-test
```

The existing Node 24.17.0 / Debian 13 Trixie build and runtime bases are retained.
Microsoft's official Debian 13 signed package feed supplies `dotnet-sdk-10.0`
in the build stage and `aspnetcore-runtime-10.0` in runtime. Debian supplies
`/usr/bin/chromium` through its normal package update path. The actual resolved
package patches belong to each image's qualification evidence, not a private
browser cache or a frozen test-browser update policy.

The build installs committed npm lockfiles, prepares Shared/TS CLI Node,
original WebUI and tracked Code extensions, then publishes complete managed
Main. `Delivery.targets` owns the resource/notices graph: templates, global
Skills and resources, Node archive/bootstrap inputs and bundles, extensions,
native PTY and Monty 0.0.19, raster dependencies and their notices. No second
Docker asset collector is maintained. Host `dist`, `node_modules`, `bin`/`obj`,
state, workspace, `data_dir`, caches and private images are not build inputs.

The default command is `dotnet Foxwarm.dll`, with `/app` as installation root,
`/data` as data root, and port 3001. No experiment overrides are baked into the
image. Node and the existing Python, compiler, Git, network and operator tools
remain available for actual JavaScript, public CLI and stdio MCP consumers.
Main itself uses the ASP.NET Core 10 runtime; the SDK is not installed in the
runtime stage. External MCP servers still need their configured dependencies.

## Compose data and shutdown

Root Compose mounts `foxwarm-data` at `/data` and publishes port 3001. Its
healthcheck, init process and optional separately paired sandbox Node remain.
Read the administrator token from `foxwarm-data/state/token`; it is not an
environment token override. Set `url` in the mounted `state/config.yaml` to the
externally reachable origin and optional mount path when configuring a reverse proxy.
The listener reads `bot.httpPort` from the same YAML (default 3001) and binds all
IPv4 interfaces.
Changing `bot.httpPort` also requires matching port/healthcheck configuration.

The retained test Compose consumer publishes host port 3003 and preserves
`test/state` at `/data/state` and `test/workspace` at `/data/agents`. The latter
is the ordinary Agents root: `main/` and other Agent folders live beneath it,
with the global `00_SYSTEM.md` at its root. Existing main-at-workspace data
requires a separately authorized stopped-instance layout adjustment before
using this mount; Main does not migrate it at startup. These private directories remain
outside Git and Docker context. Build alone does not restart a service. Set
ordinary app YAML before starting this consumer, for example:

```yaml
url: http://127.0.0.1:3003
bot:
  httpPort: 3001
```

The published URL and container listener port have separate roles. Use the actual
reachable URL for the deployment; keep the container port aligned with Compose.

A normal container stop requests Main's ordered Session drain before teardown.
Set the deployment's stop grace period for its workload; a forced timeout is
not successful drain. Restart against the same owned volume preserves data.
Source native running jobs are not automatically adopted by managed Main:
before an actual cutover, choose drain versus separately specified adoption.
Keep original Worker/controller configuration and records; those hosts and
Main TUI remain excluded.

## Optional Code workbench and HEIC

Large official Code-OSS assets are not downloaded by this recipe. Prepare a
matching asset set with the [workbench package](../packages/vscode-web/README.md),
including vendor licenses/notices, under ignored `test/.temp/code-assets`. Its
root must contain `out/`, `extensions/` and the rest of the workbench payload.
After service replacement is authorized, the retained read-only override is:

```sh
docker compose -f test/docker-compose.yml -f test/docker-compose.code.yml up -d --no-build foxwarm-dotnet-test
```

It sets `FOXWARM_VSCODE_WEB_ASSET_DIR=/opt/foxwarm/code-assets`. Without it, Main
runs and Code reports missing optional workbench assets. The optional YAML
contributor has its own workbench asset configuration.

NuGet publish supplies Skia raster input support. Optional libheif 1.23.5 /
libde265 1.1.3 are not installed; HEIC/HEIF input reports its local prerequisite
error without provider I/O. PNG/JPEG and ordinary browser screenshots do not
require HEIF. See [native image prerequisites](../dotnet/native-image-prerequisites.md).

## Qualification

A source-built image needs its own managed default startup, original App/auth/
Setup, Node source archive/resources, actual image Chromium/browser/image tool
path, normal stop/drain/restart and preserved owned-data proof. Historical
private-image or host-browser results do not qualify a new public recipe.
The managed WebUI Logs surface remains missing: the original required Logs
application scenario is enabled and fails. Successful image/publish proofs do
not establish complete default App/CI qualification or authorize a deployment.
Linux image evidence does not imply ARM, macOS, Windows container or Main AOT
support. Windows source/control qualification is separate. Default CI uses the
[maintained test runners](../docs/testing.md), not an existing installation's
ports, tokens or configuration. Local equivalents are not hosted CI runs.
