# Module: standalone native CLI Node

## Scope and contracts

The standalone .NET CLI is a manually selected remote Node client, not a .NET
Main implementation or a replacement default bootstrap. Public Main and the
TypeScript/Shell, Windows, Android and browser-extension entry points remain
unchanged. Main continues serving templates; no startup/request/install path
compiles Native AOT.

The only application build graph is `dotnet/Foxwarm.CliNode` referencing
`dotnet/Foxwarm.NodePrimitives` and `dotnet/Foxwarm.BrowserSupport`.
`dotnet/Directory.Build.props` reads the product version from root `package.json`.
The browser package is pinned to `PuppeteerSharp.Cdp` 25.14.0. Managed compilation
uses .NET 10; the independently qualified distribution target is Linux x64
static-musl. See [native delivery](../units/native-cli-distribution.md) for build,
package, notice and publication boundaries.

## Source map

- `Foxwarm.CliNode/Program.cs`, `ConsoleNode.cs`, `InteractiveNode.cs`,
  `NodeApproval.cs`: headless/interactive entry, arguments, approvals and console.
- `NodeClient.cs` and `NodeClient.*.cs`: pairing/authentication, negotiated
  protocol, reconnect ownership, tool/service/session dispatch, execution
  recovery and local triggers. Registration offers core Node protocols 1–3 and
  validates the negotiated result before authenticated side effects. Wire
  ownership remains in [node communication](../threads/node-communication.md).
- `NodePaths.cs`, `NodeFileTools.cs`, `NodeFileTransfer.cs`: explicit Agent roots,
  file tools, whole-file transfer and credential/state paths.
- `NodeExecManager.cs`, `NodeExecManager.Output.cs`: native execution tracking,
  original-capability recovery, output and accepted completion ACKs.
- `NodeCodeServices.cs`, `NodePtyService.cs`, `LocalTriggerHelper.cs`: versioned
  Code services and same-executable helpers; helpers must retain an installed
  executable path while surviving work can re-enter it.
- `NodeBrowserTools.cs` and `Foxwarm.BrowserSupport`: installed-browser launch,
  clone/evaluation serialization and CDP integration; no browser acquisition.
- `Capabilities.json`: embedded model-facing capability/schema data. Service
  transport is separate from model-tool approval.
- `Foxwarm.NodePrimitives`: shared C# file/patch/Git/exec/number/string primitives
  and `Terminal/` helpers. The static-musl target embeds the production PTY C
  object and selects its bounded spawn prelude; ordinary managed/dynamic builds
  retain their separate native-library path. It does not reference Main.

## Observable behavior

- `--token` pairs; `--auth-token` plus `--id` selects direct authentication;
  `--credentials-file` selects owned persisted credentials. `--interactive` is
  explicit; default execution is headless.
- Main host URLs retain their base path before `/node_ws`. Standard proxy
  environment variables and `NO_PROXY` are honored without logging credentials.
- Exec completion can survive client exit and recover under the original grant;
  accepted ACKs retire tracking without replaying the command effect.
- Node services advertise filesystem/Git/PTY separately from tools. PTY and
  triggers re-enter this executable rather than delegating implementation to
  Node, Python or a .NET host in Native AOT delivery.
- Git and Chromium remain optional external programs. Browser selection honors
  `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH`; absent optional programs do not
  disable ordinary core tools.

## Validation boundaries

The standalone project can be built directly without the rest of Main or the
frontend. The retained native fixture
`packages/webui/test/dotnetCliNodeAotLinux.e2e.mjs` drives an explicit executable
against an owned loopback TLS/WebSocket peer with owned state. It is a manual
native smoke entry, not an ordinary browser test. Source import/managed build
success is not new native execution or final-archive fit evidence.
