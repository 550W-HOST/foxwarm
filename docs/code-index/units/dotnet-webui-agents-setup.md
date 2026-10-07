# Unit: WebUI Agent, setup, and model configuration routes

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Agents.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Setup.cs`

## Purpose

Serves Agent creation/metadata/memory/knowledge and provider/model setup/configuration forms through Main-owned manager and model services.

## Stable methods and callers

Agent routes delegate catalog/AgentMemory/SessionManager Agent operations; setup routes validate `SetupProviderRequests`, `AppConfigurationRules`, and model YAML before saving configuration or returning forms. These routes do not make Vector fields a runtime capability.

## Contract and side effects

Setup/Agent changes are authenticated and explicit; model/settings updates are staged through manager/save-lane boundaries where they affect a Session. Agent memory selection can affect later prompts but does not rewrite active history. Unsupported remote/managed/child fields return explicit validation errors rather than being stored as accepted consumers.

## Tests

`WebUiStartupTests.cs`; `AppConfigurationRulesTests.cs`; `AppConfigurationRulesTests.cs`; AgentMemory/setup/model configuration tests.
