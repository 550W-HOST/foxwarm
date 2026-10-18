# Thread: Tool discovery, authorization, local effects, and remote capabilities

## Producer to consumer path

```text
Model response / ToolScript host call / MCP or Node definition
  -> ToolRegistry + UnifiedTools schema
  -> ToolAuthorizationAuthority/Evaluation
  -> SessionToolExecutor
  -> local file/workspace/exec, Session save operation, MCP client, or remote Node transport
  -> ToolOutputGuard/ToolResponseFormatting
  -> model turn + WebUI tool timeline
```

- **Producer:** provider adapters, MCP discovery, Main builtins, and shared Node capabilities contribute definitions; `UnifiedToolDefinitions` normalizes names/schema/limits.
- **Owner:** `ToolRegistry` resolves concrete definitions; `ToolAuthorizationEvaluation` owns allow/deny/path-scope decision; `SessionToolExecutor` owns execution context and result lifecycle; local units own effects only after authorization.
- **Durable boundary:** Session-changing tools call `SessionManager`/`SessionSaveLane`; files/workspace write through `FileToolCore`/`WorkspaceTools`; exec lifecycle lives in `LocalExecManager`; file delivery/image references use their stores; ToolScript uses `ToolScriptRunStore`; MCP/Node effects remain external transport boundaries.
- **Consumers:** model adapters receive bounded tool results; WebUI timeline renders status/output; Session owner finalizes canonical tool messages through the model/turn save path.

## Authorization and effect ordering

Definition discovery is not authorization. Invalid/ambiguous rules fail closed; remote capability presence does not grant local permission or bypass path/cwd policy. `ToolOutputGuard`, `BoundedTextExcerpt`, confirmation types, and truncation protect observable result size and sensitive handoff/file delivery paths. A tool result must identify accepted/committed/failed state accurately; accepted best-effort queue admission is not durable completion.

## Local file/exec boundary

`MainNativePaths` resolves roots; `FileToolCore`/`WorkspaceTools` enforce bounded reads/writes/patches; `LocalExecManager` owns cwd/env/process/parallel/persistent exec; `FileDeliveryDefinitions` produces authenticated deployment-relative delivery. Retry-safe write refs and post-effect ambiguity are preserved rather than guessed away.

## Outbound MCP values and trusted control

The [outbound MCP client](../units/mcp.md) receives an actual trusted Session owner from unified discovery/execution, including nested ToolScript. Its SDK bindings are transient connection authority, not Session history or a model-supplied caller identity. Real configuration changes, identity moves, deletion, and host shutdown invalidate their corresponding lifetimes.

`McpClient.CallAsync`, `ToolRegistry.ExecuteAsync`, `TurnToolExecution.Response`, `ITurnToolExecutor`, and ToolScript's `CallTool` carry JSON values, including arrays, scalars, and null. MCP [Source normalization](../units/src-mcp-client.md#d-mcp-source-normalization) happens once at that boundary. Native ToolScript receives the source value without an invented `output` wrapper; ordinary model history retains objects/arrays and wraps only scalar/null values for the established model projection. Image extraction/reference hydration and normal text truncation still apply; completed audio/binary resource content is retained as data.

`TurnToolReceipt` remains a separately typed trusted executor result. Untrusted MCP result fields do not create send/task/wait receipts, mutate caller identity, supply local resolved paths, or trigger a control operation. Provider output formatting is a history projection; it does not replace the source value or perform MCP normalization.

## Ordinary external MCP entry

[Inbound MCP](../units/dotnet-inbound-mcp.md) uses verified Main-owned external contexts and concrete external-default-deny facts, not the internal Session executor or result formatter. Its five wrappers resolve real outbound MCP, bounded Session operations, existing pairing and compatible CLI external-owner effects. Strict external Session admission remains separate from ordinary best-effort WebUI input. Notifications/reply channels are not advertised in this phase.

## Canonical units and tests

- [Unified tools](../units/tools-registry.md)
- [Authorization](../units/tool-authorization.md)
- [Local I/O](../units/tools-local-io.md)
- [MCP](../units/mcp.md)
- [Remote Node compatibility](./remote-node-compatibility.md)
- Main-local tools, authorization effects/path scope, exec, file-delivery, patch, output, and handoff-confirmation tests.
