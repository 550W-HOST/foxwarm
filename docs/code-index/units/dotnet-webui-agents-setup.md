# Unit: WebUI Agent, setup, and model configuration routes

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Agents.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Setup.cs`

## Purpose

Serves Agent creation/metadata/memory/knowledge and provider/model setup/configuration forms through Main-owned manager and model services.

## Stable methods and callers

Agent routes delegate catalog/AgentMemory/SessionManager Agent operations. The original Architecture inspector sends `DELETE /api/agents/:agentId` with exact `confirmAgentId`; the authenticated route calls `SessionManager.DeleteAgentAsync`, returns `{success, agentId, deletedSessions}` with canonical IDs and publishes topology invalidation. Scoped identities remain denied. It preserves Source error mapping: not-found text is 404, active/busy/attachment/inheritance/mutation/deletion-stopped conflicts are 409, and other failures (including later cleanup errors) are 400. Per-Session partial cleanup is not rolled back or replaced by an Agent-wide progress promise. See [lifecycle and identity](./session-manager-lifecycle-identity.md#agent-deletion-callers) for the caller-specific selection, preflights and effects. Setup routes validate `SetupProviderRequests`, `AppConfigurationRules`, and model YAML before saving configuration or returning forms. `RegisterSetupRoutes` forwards the actual `SaveAppAsync`, `SaveChannelsAsync`, and `SaveAsync` installation results (`saved`, `target`, `applied`, `notApplied`, `restartRequired`) alongside existing config/reload or model payload fields. These routes do not make Vector fields a runtime capability.

## Contract and side effects

Setup/Agent changes are authenticated and explicit. Setup save success means the validated file was installed. Shared access identities and registered inbound MCP apply live; external-channel installation returns actual managed reload and partial results. Unsupported adapters remain unavailable rather than being reported as successfully applied. Model/settings updates are staged through manager/save-lane boundaries where they affect a Session. Agent memory selection can affect later prompts but does not rewrite active history. Unsupported remote/managed/child fields return explicit validation errors rather than being stored as accepted consumers.

The current Setup does not expose Authorizations. The normal host retains [outbound OAuth administrator routes](./dotnet-mcp-oauth.md), saved grants and the narrow public callback/client documents independently of this setup file; existing caller tool permissions still control MCP use.

## Tests

`AgentDeletionHttpTests.cs`; `WebUiStartupTests.cs`; `AppConfigurationRulesTests.cs`; AgentMemory/setup/model configuration tests.

Agent creation and PUT updates accept existing `isolatedNode` metadata through the [external Node unit](./external-nodes.md). Binding changes use the established owner/save lane; they do not create a remote environment.

The real authenticated Weixin QR start/wait routes and confirmed-owner merge use the existing Setup/HTTP boundary; [Matrix/Weixin](./dotnet-matrix-weixin.md) owns their source files, wire contract and selected-command versus reload-all distinction.

WebUI `POST /api/sessions` reads both Content-Length and chunked JSON (including the ordinary .NET `JsonContent` caller). Bodyless requests, zero-byte JSON streams and empty objects retain ordinary generated creation; nonempty malformed/non-object bodies and existing invalid fields keep their error path. The local route buffers framed bytes only to distinguish an empty stream before the existing JSON object validation; it does not alter authentication, scoped admission, name handling or committed-creation error responses. `WebUiStartupTests.SessionCreation` compares actual length-bearing/chunked requested identities, catalog/history visibility, first-root ordering and empty/malformed/access controls with the Source HTTP caller.

WebUI `POST /api/sessions` places the created root before its current root siblings through the existing catalog presentation mechanism before success acknowledgement. This caller-specific order matches Source and keeps the new Session visible in the bounded initial Sidebar window even after prior ranking/moves. It does not change general Session creation defaults or paging limits; ordinary creation and presentation failures retain their existing partial-effect boundaries. `WebUiStartupTests` covers more than 50 ranked roots, prior moves and persisted order after restart.
