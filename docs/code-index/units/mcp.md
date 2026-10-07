# Unit: Outbound MCP client

Files: `dotnet/Foxwarm/McpClient.Connections.cs`, `dotnet/Foxwarm/McpClient.cs`, `dotnet/Foxwarm/McpConfiguration.cs`

## Purpose

Loads configured outbound MCP servers, pools official SDK connections/transports, and exposes discovered tools/resources through the .NET host.

## Stable methods and callers

`McpConfiguration` parses the configured server set under the data/config root; `McpClient` owns connection acquisition/release, tool/resource discovery, and shutdown; the partial connection file contains pooled transport/client lifetime. Host startup and `UnifiedTools` consume the client through the tool registry.

## Contract and side effects

MCP tools enter the same unified discovery/authorization boundary as local tools; the client does not bypass `ToolAuthorizationAuthority` or become Session state. Connection failures are external-service failures and must not be mistaken for missing local tool definitions. Shutdown drains/disposes pooled SDK clients.

## Tests

`dotnet/Foxwarm.Tests/Tools/MainLocalToolsTests.cs`; MCP compatibility coverage in the TypeScript package where outbound payloads are compared.
