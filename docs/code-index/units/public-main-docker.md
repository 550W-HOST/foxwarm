# Unit: Public managed Main Docker delivery

Files: Dockerfile, .dockerignore, docker-compose.yml, test/docker-compose.yml, test/README.md
Secondary files: dotnet/Foxwarm/Delivery.targets, Dockerfile.node, .github/workflows/tests.yml

## Contract and rationale

Production and test Compose build one root recipe and start complete managed Main. Node 24.17.0 on Debian 13 Trixie and the existing operational tools remain available for real JavaScript, public CLI and stdio MCP usage; changing Main runtime does not remove that environment. Microsoft's official Debian 13 signed package feed supplies the build SDK and ASP.NET Core 10 runtime. Debian supplies `/usr/bin/chromium` through ordinary package updates, independently of CI's test-browser pin. A private image or browser cache is not a public delivery input.

The recipe prepares assets then publishes the [existing resource graph](./core-delivery-cli.md#build-and-resource-boundary); it has no separate asset copier. Docker context excludes host dependencies/build outputs, installation data and caches. Ordinary npm locks, pinned NuGet packages and pinned Monty acquisition run inside build layers. The runtime retains resources/native helpers/notices and has no baked experiment settings. Large optional Code workbench assets and optional HEIF remain external prerequisites.

After the dependency-install layer, the build stage explicitly copies `tsconfig.artifacts.json`, its extended root `tsconfig.json` and the three Main artifact helper sources (`managedPrepare.ts`, `reactCompiler.ts`, `rasterMetadata.ts`). These are the bounded Main inputs to `build:artifacts`; its Shared validator imports come from the preceding `build:node` output. Neither host-generated helpers nor the full Source Main tree are compiler inputs to this recipe.

## Consumers and side effects

The default command is `dotnet Foxwarm.dll`, installation root `/app`, data root `/data`, port 3001. Root Compose retains its data mount, init process, healthcheck and separately paired optional sandbox Node. Test Compose uses the same recipe but preserves its existing host port and explicit legacy physical workspace; this is not the image default or an automatic data migration. Both use Main's normal stop/drain. Forced deployment grace expiry is not successful drain.

`Dockerfile.node` remains an independent Node-only build and is not redirected to managed Main. Source/native-job adoption, Worker/controller hosting, Main TUI and public promotion remain outside this delivery candidate. Linux x64 image qualification establishes no other architecture, operating system or Main AOT claim.

## Validation

A clean public-source build must start managed Main without host `dist`, `node_modules`, private native/browser caches or real data. Qualification covers original App/auth/Setup, packaged Node archive/resources, native ToolScript and a Main screenshot/image path using the actual image Chromium, plus normal stop/restart with preserved owned data. [Maintained test runners](./test-runner.md) own managed solution, complete-publish and default application tests; local equivalents are not a hosted Actions run.
