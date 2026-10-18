# Module: MCP

The .NET MCP boundary owns ordinary inbound external contexts and configured outbound SDK connections. Concrete external authorization and real Session/CLI services back the inbound catalog; outbound tools also contribute to ordinary internal unified discovery. MCP does not replace Session ownership or persistence.

## Units

- [Ordinary inbound MCP](../units/dotnet-inbound-mcp.md)
- [Outbound MCP client](../units/mcp.md)
- [Instance-shared outbound OAuth](../units/dotnet-mcp-oauth.md)

## Cross-module contract

Tool resolution and authorization remain canonical in [Tools, permissions, and exec](../threads/tools-permissions-and-exec.md); this module supplies both the client side and the separately authorized external-context entry.
