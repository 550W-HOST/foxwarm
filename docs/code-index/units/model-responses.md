# Unit: OpenAI Responses HTTP and WebSocket adapters

Files: `dotnet/Foxwarm/Models/Responses/HostedResponsesTools.cs`, `dotnet/Foxwarm/Models/Responses/OpenAIResponsesClient.cs`, `dotnet/Foxwarm/Models/Responses/ResponsesRequestPlan.cs`, `dotnet/Foxwarm/Models/Responses/ResponsesStreaming.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsChatService.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsResource.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsState.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsTransport.cs`

## Purpose

Plans and sends Responses requests, collects event streams, executes supported hosted tools, and manages stateful Responses WebSocket leases/handshakes.

## Stable methods and callers

- `ResponsesRequestPlan` derives request JSON, previous-response/state handles, tool definitions, image parts, and journal-safe request text.
- `OpenAIResponsesClient.SendAsync` owns HTTP response status/error handling and returns a streaming/non-streaming attempt result.
- `ResponsesStreaming` parses response events, records output text/reasoning/tool calls/usage, and stops on terminal/error events.
- `HostedResponsesTools` exposes provider-hosted search/hosted tools as definitions/results; it does not grant local filesystem or Session authority.
- `ResponsesWsChatService`, `ResponsesWsResource`, `ResponsesWsState`, and `ResponsesWsTransport` own connection lease, handshake, resumable state, close/error, and resource disposal for WebSocket turns.

Callers: `SessionChatService`, `ModelRouting`, `UnifiedTools`, image transport, and request journal. The turn host decides when a provider result becomes canonical Session history.

## Contract and side effects

HTTP/SSE and WebSocket attempts preserve provider request IDs and usage/error provenance. A disconnected stream or invalid event leaves the attempt incomplete; retry preparation must use the safe request-history state rather than duplicating partial assistant/tool records. Hosted tools remain provider-scoped and are not confused with local ToolAuthorization.

## Tests

`dotnet/Foxwarm.Tests/Models/ResponsesClientTests.cs`; `ResponsesStreamingTests.cs`; `ResponsesWsTests.cs`; `HostedResponsesToolsTests.cs`; hosted WebSocket image tests.
