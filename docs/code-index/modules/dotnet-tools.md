# Module: Tools and permissions

Unified tool discovery, authorization, bounded local I/O, exec, delivery, waits, and MCP-facing definitions.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Unified tools and Session tool execution](../units/tools-registry.md)
- [Main-owned artifact publication](../units/dotnet-artifacts.md)
- [Shared native file primitives](../units/dotnet-node-primitives.md)
- [Local file, exec, delivery, and workspace tools](../units/tools-local-io.md)
- [Tool authorization](../units/tool-authorization.md)
- [Legacy isolation migration](../units/isolation-migration.md)
- [Node list visibility](../units/node-list-visibility.md)
- [External Node trust and ordinary tools](../units/external-nodes.md)
- [Outbound MCP client](../units/mcp.md)
- [Tool-output secret masking and writer guard](../threads/secret-references-and-redaction.md#redaction-points)
- [Session notifications and explicit text channels](../units/dotnet-mcp-notifications.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
