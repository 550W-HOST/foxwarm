# Unit: Unified tool registry and Session tool execution

Files: `dotnet/Foxwarm/Tools/AgentToolDefinitions.cs`, `dotnet/Foxwarm/Tools/BoundedTextExcerpt.cs`, `dotnet/Foxwarm/Tools/CompactToolDefinition.cs`, `dotnet/Foxwarm/Tools/KnowledgeToolDefinitions.cs`, `dotnet/Foxwarm/Tools/MemoryTools.cs`, `dotnet/Foxwarm/Tools/ObservationToolDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionSettingsDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.ToolScript.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Tools/TimerToolDefinitions.cs`, `dotnet/Foxwarm/Tools/ToolCallControls.cs`, `dotnet/Foxwarm/Tools/ToolOutputGuard.cs`, `dotnet/Foxwarm/Tools/ToolRegistry.cs`, `dotnet/Foxwarm/Tools/ToolResponseFormatting.cs`, `dotnet/Foxwarm/Tools/ToolScriptToolDefinitions.cs`, `dotnet/Foxwarm/Tools/UnifiedToolDefinitions.cs`, `dotnet/Foxwarm/Tools/UnifiedTools.Schema.cs`, `dotnet/Foxwarm/Tools/UnifiedTools.cs`, `dotnet/Foxwarm/Tools/WaitToolDefinitions.cs`

## Purpose

Discovers concrete tools, projects model definitions, applies output/control policies, and executes Session-local tools for memory/knowledge, observation, waits, settings, timers, compaction, and ToolScript.

## Stable methods and callers

- `ToolRegistry` combines builtins, MCP, provider-hosted definitions, and permitted Node capabilities into one discovered set with stable names/schemas.
- `UnifiedToolDefinitions`/`UnifiedTools.Schema` publish model-facing JSON; `UnifiedTools` resolves calls and carries Session/agent/request scope into execution.
- `SessionToolExecutor` dispatches definitions, commits observation/memory/wait/settings/timer/compact changes through SessionManager/save-lane APIs, and returns source JSON values with separately typed trusted receipts; the `session` tool resolves targeted status through the real Main owner and applies parent changes through catalog presentation mutation; its ToolScript partial bridges to MainToolScript. The default-hidden `set_agent_isolated` binds/clears existing Agent Node metadata and updates legacy exact rules through the established Agent tool executor. Advertised external tools use current or explicit Node capability snapshots from the [external Node unit](./external-nodes.md); builtin name collisions stay source-qualified, and external exec uses the [remote exec authority unit](./remote-exec.md). Copy, image export/delivery and remote source use the [file consumers unit](./external-node-files.md), preserving their distinct builtin and path identities.
- `ToolCallControls`, `ToolOutputGuard`, `BoundedTextExcerpt`, and `ToolResponseFormatting` enforce call ordering, size/truncation, status/error envelopes, and provider-visible output boundaries.

## Contract and side effects

Definition discovery is not authorization: execution calls `ToolAuthorizationEvaluation` before local/MCP/Node effects. Tools that change Session state use owner/save-lane boundaries; a model-visible success is not emitted before the underlying operation reports its committed/accepted outcome. Provider-hosted tools remain provider-scoped. JSON source values and model/history projection follow [the cross-module tool contract](../threads/tools-permissions-and-exec.md#outbound-mcp-values-and-trusted-control).

Default model requests project the selected compatible Node's advertised tools, including `exec`, through current concrete visibility policy. An absent capability or hidden tool is not injected from Master. Builtin name collisions remain source-qualified, and explicit schema overrides retain their existing projection behavior.

## Tests

`dotnet/Foxwarm.Tests/Tools/MainLocalToolsTests.cs`; `ToolAuthorizationEffectsTests.cs`; `HandoffConfirmationTests.cs`; ToolScript tool tests. `RemoteExecProtocolTests.cs` covers selected-Node exec advertisement, policy hiding, builtin collisions and explicit overrides. `packages/webui/test/experimentHostRemoteExecSchemas.e2e.mjs` checks real provider request schemas before direct and adjacent exec effects through the unchanged official CLI, plus policy-hidden schemas and canonical pairs; its provider refuses undeclared calls.
