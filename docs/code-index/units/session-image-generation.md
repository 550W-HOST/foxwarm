# Unit: Separate image generation

Files: `dotnet/Foxwarm/Sessions/SessionManager.ImageGeneration.cs`, `dotnet/Foxwarm/Models/ImageGenerationRequests.cs`, `dotnet/Foxwarm/Models/ImagesApiChatService.cs`
Secondary files: `dotnet/Foxwarm/Models/SessionChatService.cs`, `dotnet/Foxwarm/Models/ConfiguredModelRequests.cs`, `dotnet/Foxwarm/Models/HostModels.Resolve.cs`, `dotnet/Foxwarm/Sessions/SessionOwner.cs`, `dotnet/Foxwarm/Tools/MainLocalToolDefinitions.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Authorization.cs`, `dotnet/Foxwarm.Tests/Models/SeparateImageGenerationTests.cs`, `dotnet/Foxwarm.Tests/Models/ImagesApiImageGenerationTests.cs`

`imageGeneration.mode: separate` exposes `generate_image` instead of the native conversation image tool. Omitted mode and `hosted` keep native hosted generation. The earlier `isolated` spelling remains accepted as a compatibility alias; new configurations should use `separate`, avoiding confusion with legacy Agent isolation metadata. No file rewrite is required to keep existing configurations working.

`SessionChatService` captures the concrete model and catalog before each attempt's declarations. During its tool loop, declarations, discovery and dispatch use that captured leaf, including failover and session-hash routes. The separate request retains that leaf rather than rerouting with a fresh image cache key. A changed explicit model selection invalidates the previous selection. Outside an active model turn, only a directly selected concrete model can supply this capability; a virtual route has no adopted tool-producing leaf yet. Hosted and disabled models neither declare nor discover this builtin, and guessed direct/unified calls are rejected before dispatch. Normal tool authorization still applies to an enabled capability.

The Session boundary validates a bounded visual prompt and at most eight same-Session image IDs. IDs resolve against current and archived caller history before any provider request; credentials and filesystem paths are not accepted. Successful images return through the existing `imageParts` reference carrier and normal tool-image persistence/delivery. Missing images become a normal tool error.

`ImageGenerationRequests` owns the dedicated request policy: prompt/reference-only history, fixed image instructions, no functions or search, one attempt, cancellation propagation and no reasoning. The separate request never changes Session reasoning effort or appends a detached assistant message into canonical history. Both backends run through `ModelRequestOwner` with journal purpose `image-generation`, retaining secret masking, text redaction, diagnostics and request journal handling.

## Request backends

`imageGeneration.api` selects the backend of the separate request ([D-image-generation-images-api](#d-image-generation-images-api)):

- `responses` (default when omitted): a Responses request with a single forced native image tool. Its wire builder is selected before ordinary Responses planning; reserved `extraFields` cannot restore reasoning, ordinary conversation state, functions or cache continuation. Image options use the same native image-tool builder as hosted generation. Other provider extensions retain their established behavior. HTTP and WebSocket providers use their normal transport.
- `images`: `ImagesApiChatService` calls the OpenAI Images API on the leaf's `baseUrl` with its `apiKey` and `extraHeaders`. Without reference images it POSTs JSON to `{baseUrl}/images/generations`; with reference images it POSTs multipart to `{baseUrl}/images/edits`, one `image[]` part per reference (hydrated through the normal provider image path) plus `model`, `prompt` and options. It is always plain HTTP; an `openai-ws` provider's `ws`/`wss` base URL maps to `http`/`https`. `size`, `quality`, `background`, `outputFormat` and `outputCompression` map to `size`, `quality`, `background`, `output_format` and `output_compression`; `action` has no Images API form, since the endpoint follows from the references. `response_format` is not sent (GPT image models always return `b64_json`).

Images API configuration is validated after provider → model inheritance: the effective settings need `mode: separate` (or `isolated`) and a nonempty `model`; there is no default image model.

Images API results are accepted only as `b64_json`. Each image is strictly decoded, recognized by raster signature, checked against the response `output_format`, bounded by the hosted-image per-image, cumulative and count limits, and stored as a content-addressed blob with `imageMeta.origin = "generated"`; it has no native replay metadata, so later requests use the existing generated-image placeholder rules. URL-only or rejected items become a tool error. The journal and diagnostics record form fields plus a digest per uploaded image and omit `b64_json`. Response `usage` is recorded with the attempt; the conversation model's `pricing` is not applied to image tokens (`ChatResult.UsageUnpriced`). Non-2xx responses become a non-retryable, non-countable failure whose concise message carries the provider's `error.message`. The non-streaming response uses the ten-minute image inactivity floor.

Text redaction applies to the prompt as on the Responses path. Image output has no text to restore, and original values are never sent.

## Tool failures

A failed separate request, local preparation failure or journal preparation failure is the tool's own result: `GenerateImageAsync` converts every non-cancellation exception from the request owner into a tool error `Image generation failed: <reason>` ([D-image-generation-failure-is-tool-result](#d-image-generation-failure-is-tool-result)). Cancellation and turn shutdown keep their existing tool-cancellation handling.

## Tests

`SeparateImageGenerationTests` exercises Responses-backend HTTP/WS tool loops for concrete, failover and session-hash selections, including a failed primary, exact image-leaf affinity, mixed-mode failover rejecting a guessed separate call, normal high-effort preservation, ownership and journal references, one-attempt failures and cancellation. Declaration/discovery/direct/unified authorization tests cover hosted, disabled, separate and legacy modes. Wire policy tests reject reasoning and ordinary-history overrides from `extraFields`.

`ImagesApiImageGenerationTests` runs normal turns against a local HTTP fixture for HTTP and WS providers: JSON generations with option mapping, credentials and extra headers; multipart edits with two `image[]` parts; provider error bodies as persisted tool errors with a continuing turn and a journal failure record; URL-only results; usage without conversation pricing; inheritance and validation; and WS base-URL mapping. Its Responses-backend regression test proves a failed forced-image request persists a tool error and the turn makes its follow-up model request.

## Design decisions

### D-image-generation-images-api

[2026-11-16, user] Separate image generation gets an Images API backend for OpenAI-compatible routes that cannot force hosted `image_generation` on a Responses request. It is selected with `imageGeneration.api: images` and requires an explicit `imageGeneration.model`; the Responses backend remains the default and keeps its behavior. The request uses the provider's connection settings over plain HTTP even for `openai-ws`, because the Images API has no WebSocket form.

### D-image-generation-failure-is-tool-result

[2026-11-16, user] A failed `generate_image` always yields a persisted tool error and the turn continues like any other tool error. Previously a `ModelRequestException` from the one-attempt image request escaped tool dispatch (neither the tool executor nor the turn host maps that type), ended the turn as a model failure and left the function call without a function response. Among tool handlers, only `generate_image` awaits a `ModelRequestOwner` request inside dispatch: ToolScript `request_model_without_context` failures become a script `RuntimeError`, and compaction, BTW and automatic titles are scheduled or user-command paths.
