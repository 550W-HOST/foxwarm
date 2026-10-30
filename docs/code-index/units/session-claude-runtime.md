# Unit: Claude Code Session runtime

Files: `dotnet/Foxwarm/Sessions/External/ClaudeRuntimeConfiguration.cs`, `dotnet/Foxwarm/Sessions/External/ClaudeRuntimeState.cs`, `dotnet/Foxwarm/Sessions/External/SessionRuntimeCredentialStore.cs`, `dotnet/Foxwarm/Sessions/External/ClaudeRuntimeToolSupport.cs`, `dotnet/Foxwarm/Sessions/External/ClaudeSessionDriver.cs`, `dotnet/Foxwarm/Sessions/External/RuntimeMcpService.cs`, `dotnet/Foxwarm/Sessions/External/LocalSessionTurnHost.Claude.cs`

## Runtime and trust contract

The external runtime is one ordinary Main-owned internal Session and foreground processor. It replaces the model loop inside `LocalSessionTurnHost.ChatAsync`; it does not introduce an ordinary inbound MCP identity, another Session, a second model loop, or a generic runtime platform. Runtime selection is creation-only, defaults to `foxwarm` even for children of an external parent, and accepts `claude-code` through the two creation tools and the human Session creation API. The CLI owns its model/login configuration. Foxwarm does not supply a model flag, account key, LLM proxy, `--bare`, or an authentication-directory override.

The host account, executable, and effective administrator-controlled configuration are trusted prerequisites. Configured automatic effects outside the bridge are not controlled by Foxwarm tool policy. The settings overlay suppresses hooks only in the CLI's documented ordinary-settings scope; administrator-managed hooks and force-enabled managed plugin hooks may run. Initialization checks refuse observable tool/plugin/MCP/permission mismatches, but successful init cannot establish that no managed hooks ran. The user guide is `docs/claude-code-sessions.md`. Controlled tests establish bridge/lifecycle behavior, not installation-account qualification or host isolation.

## Input and persistence

`ClaudeRuntimeState` validates the creation selector and version-2 external checkpoint. Version 1 remains the Foxwarm authority format; older version-1 readers already refuse version 2. The checkpoint contains the external UUID, Main-local cwd/transcript reference, input frontier/latest-user high-water, run status, observed model/auth-source metadata, and latest CLI usage estimate. It contains no run credential.

`SessionTurnRunner` commits one ordinary queued input unit before invoking the driver. New input remains queued until that run settles. The driver resumes the recorded UUID and sends only user rows beyond the committed input frontier, not a replay of Main history. It records that frontier before writing NDJSON to stdin. Known pre-submission failure restores the previous checkpoint/frontier; unknown input outcomes are never automatically replayed. A recovered unfinished run becomes interrupted without the ordinary recovery-trigger synthesis. Continue uses the interrupted checkpoint or known unsubmitted user sequence, including completed CLI runs with no text response. Missing transcripts refuse resume; Clear creates a new external context through the existing lifecycle owner.

Checkpoint changes share the existing canonical save lane and publication boundary. Complete assistant rows and known partial text on interruption use canonical history append. CLI tool echoes, compact boundaries, and result metadata do not execute business tools or change Main's history version/Archive. The latest result usage is source-labeled; its possibly cumulative CLI cost is not added to Foxwarm API totals. Hot metadata, cold catalog projections, history DTOs and the composer expose the CLI model/source and Continue capability without substituting a Foxwarm provider default or inventing an LLM journal request.

## Exact-run bridge

`SessionRuntimeCredentialStore` is Main-process-local and separate from ordinary access identities. A cryptographically random credential binds the exact owner, Session ID, Agent, foreground run, expiry, and callback. Renewal requires that same live run; expiry/revocation cannot be revived. Process exit removes tool admission even while already buffered CLI output is settled. Stop, failure/result, move, deletion and shutdown revoke credentials; no credential authority survives restart. Per-run mode-0700 directories and mode-0600 MCP/settings/prompt files are removed after drain, and stale run files are removed when a new manager starts.

`RuntimeMcpService` serves `/runtime/mcp` through the actual MCP SDK's stateless Streamable HTTP transport. The route has independent bearer authentication and does not use ordinary inbound identity promotion. It exposes the canonical `search_tools` and `call_tool` wrappers. Tool calls and CLI observations share a per-run lane. The driver callback uses `ExecuteRuntimeToolAsync`, which reuses the normal attributed executor, canonical call/result rows, receipt consumption, complete-row settlement, output guards and image hydration. Raw tool identity arguments cannot select an actor. Policy and runtime support are checked again at resolved concrete dispatch, including unified aliases and `argsJson`.

`ClaudeRuntimeToolSupport` filters unsupported tools from normal discovery, narrows runtime-only handoff schemas, and rejects unsupported concrete effects. It refuses wait, ToolScript run/resume controls, Foxwarm compaction, response-wide batch controls, non-continue handoffs and current-Session identity/Stop controls. Ordinary canonical definitions and independent unattended work keep their normal semantics. Claude Code's `EndConversation` is an accepted driver control observation, not a business tool.

## Process and lifecycle owners

`ClaudeSessionDriver.Command` uses Linux `setsid` with structured arguments, bounded UTF-8 NDJSON records, a single strict MCP config, native-tool removal, and a tool-surface-only overlay. A result fences tool admission before canonical completion. Failure/Stop joins admitted tool work before processor release; cancellation interrupts the owned process group and escalates to termination, including descendants that outlive the root. The existing `SessionControl`, identity move, deletion, shutdown and Clear owners retain their admission/drain responsibilities. Independent Main-owned background Exec and ToolScript lifetimes are not moved into the CLI process group.

The driver never spawns a model subprocess in automated tests. The controlled executable is selected through normal configuration, not a production test branch. No extra provider/model settings are used.

## Integration references

- [Session turns](session-turns.md): foreground claim, canonical publication and final assistant/handoff controls.
- [Unified tool registry](tools-registry.md): concrete resolution, attribution, authorization and output guards.
- [Inbound MCP](dotnet-inbound-mcp.md): separate ordinary external identity boundary.
- [Authority JSON](session-authority-json.md) and [catalog projections](session-catalog-projection.md): format gate and cold metadata.
- [WebUI core](dotnet-webui-core.md): creation API, history DTO and model/runtime presentation.

## Tests

`dotnet/Foxwarm.Tests/Sessions/ClaudeRuntimeTests*.cs` and `ClaudeRuntimeFixture.cs` use owned state/configuration, a controlled NDJSON child and the installed JavaScript/C# MCP SDKs. They cover actual registry file effects, output spooling and image results, reporting receipts, pre-effect unsupported controls and live policy changes, actor-argument rejection, runtime selection, hot/cold projection, duplicate/late events, crash/partial/malformed/configuration failure, transcript loss, Stop/move/delete/shutdown revocation, renewal/expiry, startup recovery, Clear, process descendants and independent background Exec lifetime. The fixture never invokes a real Claude model or copies account credentials.
