# Unit: .NET headless CLI Node

Files: `dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj`, `dotnet/Foxwarm.CliNode/AssemblyInfo.cs`, `dotnet/Foxwarm.CliNode/Program.cs`, `dotnet/Foxwarm.CliNode/NodeClient.cs`, `dotnet/Foxwarm.CliNode/MasterProxy.cs`, `dotnet/Foxwarm.CliNode/NodePaths.cs`, `dotnet/Foxwarm.CliNode/NodeFileTools.cs`, `dotnet/Foxwarm.CliNode/NodeFileTransfer.cs`, `dotnet/Foxwarm.CliNode/Capabilities.json`, `dotnet/Foxwarm.Tests/Tools/CliNodeFileTests.cs`, `packages/webui/test/dotnetCliNodeProtocol.e2e.mjs`, `packages/webui/test/dotnetCliNodeFiles.e2e.mjs`

## Purpose and boundaries

A separate .NET 10 executable implements a headless, file-capable CLI Node. It references the [small native primitive library](./dotnet-node-primitives.md), not the Main executable. The existing TypeScript CLI, interactive entry and bootstrap remain unchanged. This is not full CLI parity or a native-published delivery artifact.

The implemented model tools are `read`, `write`, `edit`, `apply_patch` and `get_default_cwd`. Capability definitions retain the corresponding TypeScript CLI descriptions and schemas. Only implemented tools and `programmaticToolData` are advertised. Exec, external owners, Code/Git/PTY/browser services, the local trigger and approval/history/send UI are not implemented or advertised by this executable.

## Stable symbols and caller paths

| Symbol | Responsibility |
|---|---|
| `Program.Main`, `Parse` | Headless argument entry, signals and shutdown; accepts host, ID, shared pairing token, per-node auth token and optional credential file. |
| `NodeClient.Run`, `Receive` | Credential precedence, pairing/auth registration, protocol validation, reconnect and receive ownership. |
| `NodeClient.Dispatch`, `Connection.Send` | Session file calls and whole-file transfer replies, serialized sends and originating-connection ownership. |
| `NodeClient.ValidateProtocol` | Current 1–3 offer, newest compatible selection, missing legacy negotiation and rejection before credential registration effects. |
| `MasterProxy.Resolve`, `Create`, `Safe` | Environment-only proxy selection, credentials and password-redacted presentation. |
| `NodePaths.AgentDirectory`, `Resolve`, `Transfer` | Startup-root Agent directories, native file/cwd expansion and lexical transfer restriction. |
| `NodeFileTools.Execute` | CLI-native file effects and errors, image/programmatic results and success-only resolved-path sidecars. |
| `NodeFileTransfer.Read`, `Write` | Existing whole-file base64/SHA-256 wire protocol and same-directory publication. |

## Connection and state contract

- Explicit ID plus per-node auth token overrides an older credential file. Successful authenticated registration persists `{nodeId,authToken,pairedAt}`; Unix files are owner-only. Pairing approval saves credentials and reconnects after 250 ms. Ordinary reconnect waits five seconds.
- Invalid credentials clear the credential file and return to pairing only when a shared pairing token exists. Rejection or incompatible/malformed negotiation suppresses automatic reconnect. No token or credential-bearing WebSocket URL is logged.
- HTTP/HTTPS proxy lookup follows the existing lower-/upper-case and `npm_config_*`/`ALL_PROXY` precedence with `NO_PROXY`, including the WebSocket-to-HTTP scheme mapping. No implicit platform proxy is added. Proxy authentication uses the BCL challenge/response path.
- The receive loop remains active while file operations run. .NET's 30-second keepalive interval and ten-second PONG timeout detect a stale peer; this is the BCL heartbeat, not a claim of TypeScript timer scheduling identity.
- An operation can finish its filesystem effect after a connection is lost. It is not replayed, rolled back or allowed to answer through a newer connection. Main retains authorization, Session selection and response adoption.

## Native file and transfer contract

Agent directories resolve against the captured process startup cwd, with `FOXWARM_AGENT_DIR`, then `FOXWARM_AGENTS_DIR`, then `agents/<agent>`. Relative file calls prefer the supplied Session cwd and otherwise that Agent directory. A leading `$fw_agentdir` or `$fw_tmp` expands only the supported Agent token; other leading names are rejected. `get_default_cwd` returns startup cwd, independently of file defaults.

The shared scanner/excerpt, exact-match and patch algorithms do not bring Main authorization, cached-write references or interpreter budgets into this wrapper. CLI content writes/edit/patch follow native content-write behavior, including final symlinks and partial effects. JS replacement-string tokens remain a CLI edit behavior; Main's exact replacement remains literal. Patch additions do not manufacture a trailing newline. Only complete successful calls return resolved-path sidecars.

Raster reads classify header signatures, not extensions, and return inline image bytes. Programmatic text reads retain full content only within the existing bound and otherwise publish truncation/byte metadata. The directory result remains text, not a fabricated full-content record.

Whole-file transfer paths use Agent roots rather than Session cwd, preserve caller restriction flags, classify transfer MIME by extension and retain the existing checksum/receipt fields. Same-directory temporary-file publication replaces a final symlink on overwrite; no-overwrite publication does not replace an existing destination. Transfer publication is distinct from ordinary content writes and from Provider chunk operations.

## Validation and limits

`CliNodeFileTests` exercises CLI/Main content-write ownership, literal versus JS replacement semantics, partial patch effects and transfer symlink publication. The protocol process fixture compares native results/effects with the actual TypeScript client and exercises credential precedence/restart, pairing/fallback, rejection/incompatibility, stale-peer reconnect, proxy authentication and old-connection effects. The file fixture runs the actual new executable against separately owned normal TypeScript and C# Main processes, with a local model, file tools, programmatic reads, bidirectional transfer, image registration/export/delivery and client/Main restarts.

Both new projects enable trim/AOT analysis; the executable disables reflection-based JSON serialization and enables single-file analysis. JSON boundaries use explicit `JsonNode` values. Analyzer builds do not establish Native AOT delivery. Linux x64 is the exercised runtime; Windows/macOS, native publishing, complete CLI parity and bootstrap replacement remain separate work.
