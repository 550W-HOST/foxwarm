# Unit: WebUI Agent, setup, and model configuration routes

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Agents.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Setup.cs`

## Purpose

Serves Agent creation/metadata/memory/knowledge and provider/model setup/configuration forms through Main-owned manager and model services.

## Stable methods and callers

Agent routes delegate catalog/AgentMemory/SessionManager Agent operations; setup routes validate `SetupProviderRequests`, `AppConfigurationRules`, and model YAML before saving configuration or returning forms. `RegisterSetupRoutes` forwards the actual `SaveAppAsync`, `SaveChannelsAsync`, and `SaveAsync` installation results (`saved`, `target`, `applied`, `notApplied`, `restartRequired`) alongside existing config/reload or model payload fields. These routes do not make Vector fields a runtime capability.

## Contract and side effects

Setup/Agent changes are authenticated and explicit. Setup save success means the validated file was installed. Shared access identities apply live, while declared inbound MCP and external channels remain unavailable; the forwarded outcome preserves that distinction. Model/settings updates are staged through manager/save-lane boundaries where they affect a Session. Agent memory selection can affect later prompts but does not rewrite active history. Unsupported remote/managed/child fields return explicit validation errors rather than being stored as accepted consumers.

The current Setup does not expose Authorizations. The normal host retains [outbound OAuth administrator routes](./dotnet-mcp-oauth.md), saved grants and the narrow public callback/client documents independently of this setup file; existing caller tool permissions still control MCP use.

## Tests

`WebUiStartupTests.cs`; `AppConfigurationRulesTests.cs`; AgentMemory/setup/model configuration tests.

Agent creation and PUT updates accept existing `isolatedNode` metadata through the [external Node unit](./external-nodes.md). Binding changes use the established owner/save lane; they do not create a remote environment.
