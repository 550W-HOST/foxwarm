# Unit: Unified tool registry and Session tool execution

Files: `dotnet/Foxwarm/Tools/AgentToolDefinitions.cs`, `dotnet/Foxwarm/Tools/BoundedTextExcerpt.cs`, `dotnet/Foxwarm/Tools/CompactToolDefinition.cs`, `dotnet/Foxwarm/Tools/KnowledgeToolDefinitions.cs`, `dotnet/Foxwarm/Tools/MemoryTools.cs`, `dotnet/Foxwarm/Tools/ObservationToolDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionSettingsDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.ToolScript.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Tools/TimerToolDefinitions.cs`, `dotnet/Foxwarm/Tools/ToolCallControls.cs`, `dotnet/Foxwarm/Tools/ToolOutputGuard.cs`, `dotnet/Foxwarm/Tools/ToolRegistry.cs`, `dotnet/Foxwarm/Tools/ToolResponseFormatting.cs`, `dotnet/Foxwarm/Tools/ToolScriptToolDefinitions.cs`, `dotnet/Foxwarm/Tools/UnifiedToolDefinitions.cs`, `dotnet/Foxwarm/Tools/UnifiedTools.Schema.cs`, `dotnet/Foxwarm/Tools/UnifiedTools.cs`, `dotnet/Foxwarm/Tools/WaitToolDefinitions.cs`

## Purpose

Discovers concrete tools, projects model definitions, applies output/control policies, and executes Session-local tools for memory/knowledge, observation, waits, settings, timers, compaction, and ToolScript.

## Stable methods and callers

- `ToolRegistry` combines builtins, MCP, provider-hosted definitions, and permitted Node capabilities into one discovered set with stable names/schemas.
- `UnifiedToolDefinitions`/`UnifiedTools.Schema` publish model-facing JSON; `UnifiedTools` resolves calls and carries Session/agent/request scope into execution.
- `SessionToolExecutor` dispatches definitions, commits observation/memory/wait/settings/timer/compact changes through SessionManager/save-lane APIs, and returns source JSON values with separately typed trusted receipts; the `session` tool resolves targeted status through the real Main owner and applies parent changes through catalog presentation mutation; its ToolScript partial bridges to MainToolScript. The default-hidden `set_agent_isolated` binds/clears existing Agent Node metadata and updates legacy exact rules through the established Agent tool executor. Ordinary external tools use current or explicit Node capability snapshots from the [external Node unit](./external-nodes.md); builtin name collisions stay source-qualified, and remote exec is not exposed until its completion-authority phase.
- `ToolCallControls`, `ToolOutputGuard`, `BoundedTextExcerpt`, and `ToolResponseFormatting` enforce call ordering, size/truncation, status/error envelopes, and provider-visible output boundaries.

## Contract and side effects

Definition discovery is not authorization: execution calls `ToolAuthorizationEvaluation` before local/MCP/Node effects. Tools that change Session state use owner/save-lane boundaries; a model-visible success is not emitted before the underlying operation reports its committed/accepted outcome. Provider-hosted tools remain provider-scoped. JSON source values and model/history projection follow [the cross-module tool contract](../threads/tools-permissions-and-exec.md#outbound-mcp-values-and-trusted-control).

## Tests

`dotnet/Foxwarm.Tests/Tools/MainLocalToolsTests.cs`; `ToolAuthorizationEffectsTests.cs`; `HandoffConfirmationTests.cs`; ToolScript tool tests.
