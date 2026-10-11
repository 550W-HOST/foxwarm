# Unit: Tool authorization and isolation compatibility

Files: `dotnet/Foxwarm/Tools/Authorization/IsolatedToolCompatibility.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationAuthority.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationEvaluation.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationPolicy.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationToolDefinition.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYaml.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYamlGraph.cs`

## Purpose

Loads the authority YAML/graph, evaluates allow/deny effects and path scopes, emits authorization tool definitions, and preserves compatibility with isolated Node/tool policies.

## Stable methods and callers

`ToolAuthorizationAuthority.Load/Reload` parses the canonical authority graph; `ToolAuthorizationPolicy` resolves tool/path/effect matches; `ToolAuthorizationEvaluation` returns the decision, matched rule, scope, and explanation used by `ToolRegistry`/`SessionToolExecutor`; YAML graph types preserve inheritance/agent/tool rule edges. `IsolatedToolCompatibility` translates only the supported remote/isolation shape.

## Contract and side effects

Every executable local/MCP/Node capability enters authorization before dispatch. Rules provide tool authorization, not OS/network sandboxing; a remote Node's protocol capability still requires an allowed Main-side boundary. Deny/ambiguous/invalid graphs fail closed, while read-only definition discovery may report unavailable tools without invoking them.

The non-default setter is `set_config` with required `target` (`config`, `models`, or `tool-rules`) and `filePath`. There is no obsolete `set_tool_rules` command alias. Persisted generic policies that explicitly name that removed builtin fail validation with migration guidance toward deliberate `set_config` target restrictions; exact isolated metadata receives explicit migration guidance rather than an unconstrained replacement. The new setter retains the independent isolation/path/authority boundaries.

## Tests

`dotnet/Foxwarm.Tests/Tools/ToolAuthorizationEffectsTests.cs`; `ToolAuthorizationPathTests.cs`; `ToolAuthorizationSourceTests.cs`; isolation compatibility tests.
