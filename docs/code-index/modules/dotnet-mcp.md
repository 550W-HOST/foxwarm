# Module: MCP

The .NET MCP boundary loads outbound server configuration, maintains SDK connections, and contributes discovered tools to the unified registry. MCP is an external integration; it does not own Session state.

## Units

- [Outbound MCP client](../units/mcp.md)
- [Instance-shared outbound OAuth](../units/dotnet-mcp-oauth.md)

## Cross-module contract

Tool resolution and authorization remain canonical in [Tools, permissions, and exec](../threads/tools-permissions-and-exec.md); this module supplies the external client side.
