# Unit: Tool authorization and isolation compatibility

Files: `dotnet/Foxwarm/Tools/Authorization/IsolatedToolCompatibility.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationAuthority.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationEvaluation.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationPolicy.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationToolDefinition.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYaml.cs`, `dotnet/Foxwarm/Tools/Authorization/ToolAuthorizationYamlGraph.cs`

## Purpose

Loads the authority YAML/graph, evaluates allow/deny effects and path scopes, emits authorization tool definitions, and preserves compatibility with isolated Node/tool policies.

## Stable methods and callers

`ToolAuthorizationAuthority.Load/Reload` parses the canonical authority graph; `ToolAuthorizationPolicy` resolves tool/path/effect matches; `ToolAuthorizationEvaluation` returns the decision, matched rule, scope, and explanation used by `ToolRegistry`/`SessionToolExecutor`; YAML graph types preserve inheritance/agent/tool rule edges. `IsolatedToolCompatibility` translates only the supported remote/isolation shape.

## Contract and side effects

Every executable local/MCP/Node capability enters authorization before dispatch. Rules provide tool authorization, not OS/network sandboxing; a remote Node's protocol capability still requires an allowed Main-side boundary. Deny/ambiguous/invalid graphs fail closed, while read-only definition discovery may report unavailable tools without invoking them.

## Tests

`dotnet/Foxwarm.Tests/Tools/ToolAuthorizationEffectsTests.cs`; `ToolAuthorizationPathTests.cs`; `ToolAuthorizationSourceTests.cs`; isolation compatibility tests.
