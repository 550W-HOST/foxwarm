# .NET Main and tools

The .NET 10 solution contains managed Main, a standalone CLI Node, shared native/browser libraries, xUnit tests and developer probes. The optional Windows Desktop project is outside the cross-platform solution.

## Layout

| Path | Owner |
| --- | --- |
| `Foxwarm/` | Main host, HTTP/channels, Sessions, models, tools and delivery resources |
| `Foxwarm.CliNode/` | Standalone managed CLI Node |
| `Foxwarm.NodePrimitives/`, `Foxwarm.BrowserSupport/` | Shared native and browser support |
| `Foxwarm.Desktop/` | Optional Windows WinForms/WebView2 host |
| `Foxwarm.DevTools/` | `conditional-memory`, `responses-request`, `responses-stream` and `session-restart` probes |
| `Foxwarm.Tests/` | xUnit tests, source fixtures/corpora and qualification scripts |
| `scripts/` | Build, publish and source-generation helpers |

The solution, common build/format configuration and this entry document stay at the root. See the [Code Index](../docs/code-index/overview.md) for architecture and current contracts, and the [test layout and differential commands](Foxwarm.Tests/README.md) for fixture consumers.

## Build, publish and public CLI

Install the .NET 10 SDK and the root/WebUI npm dependencies first. From the repository root:

```sh
npm run build             # Complete managed Main delivery and assets
npm run build:reference   # Retained TypeScript oracle used by differential tests
npm run test:managed      # Managed suite, also included in test:unit and CI
npm run publish:core -- -r linux-x64 -o /path/to/empty/output
```

Plain `dotnet build dotnet/Foxwarm.sln` is backend-only: it does not prepare frontend assets or select the package launcher's runnable output. Complete source builds stage and select a versioned runtime; a build does not restart an existing Main. Use `node .` for source Main startup and the public `foxwarm` dispatcher for one-shot model and Archive commands.

Canonical build, resource and startup guidance:

- [Core delivery resources and public CLI](../docs/code-index/units/core-delivery-cli.md)
- [Managed source entry and controls](../docs/code-index/units/source-main-entry.md)
- [Captured paths and host configuration](../docs/code-index/units/host-runtime.md)
- [Local tests and CI](../docs/testing.md)
- [Source update procedure](../skills/foxwarm-maintenance/references/SOURCE-UPDATES.md)
- [Optional native image prerequisites](../docs/native-image-prerequisites.md)

Linux x64 and Windows x64 are the source candidate targets; cross-publishing does not qualify Windows execution, and macOS Main is not qualified. Main TUI, Session Worker hosting and managed ToolScript/controllers remain outside this candidate. Runtime and platform details belong to the linked contracts.

## Other executables

- [CLI Node contract and invocation](../docs/code-index/units/dotnet-cli-node.md), including browser and interactive behavior.
- [CLI-only Linux Native AOT recipe](../scripts/native-aot/README.md) and [measured compatibility](../docs/code-index/units/dotnet-cli-linux-aot.md).
- [Windows Desktop](Foxwarm.Desktop/README.md) and its `scripts/publish-desktop.sh` helper.
