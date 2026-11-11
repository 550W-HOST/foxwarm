# Unit: Isolated image generation

Files: `dotnet/Foxwarm/Sessions/SessionManager.ImageGeneration.cs`
Secondary files: `dotnet/Foxwarm/Tools/MainLocalToolDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Authorization.cs`, `dotnet/Foxwarm.Tests/Models/IsolatedImageGenerationTests.cs`

`generate_image` delegates to a separately owned Responses request through `ModelRequestOwner`. The caller supplies a bounded visual prompt and optional same-Session image IDs, never provider credentials or filesystem paths. Image IDs resolve against current and archived caller history before any provider request. Disabled image generation and virtual selections are rejected before dispatch.

The tool is discoverable for normal tool authorization and injected only when a concrete selected model enables `imageGeneration.mode: isolated`. It retains the caller's concrete provider/model and configured image options. Its request history contains only the supplied prompt and explicitly referenced images; no ordinary Session history, functions or web search are sent. The image request uses one attempt and propagates cancellation. It never sets the Session's reasoning effort or appends detached assistant messages into normal history.

Wire omission of reasoning, tool choice and provider purpose contracts are owned by [Responses](./model-responses.md#d-responses-hosted-tool-purpose). Successful images return through the existing `imageParts` reference carrier and normal tool-image persistence/delivery; missing images become a normal tool error. `IsolatedImageGenerationTests` exercises real HTTP/WS tool loops, normal high-effort preservation, image ownership, journal evidence, single-attempt failure and cancellation.
