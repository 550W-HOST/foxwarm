# Unit: OTLP tracing

Files: `dotnet/Foxwarm/Telemetry/OtlpConfiguration.cs`, `dotnet/Foxwarm/Telemetry/FoxwarmTraces.cs`, `dotnet/Foxwarm/Telemetry/FoxwarmTraces.GenAi.cs`, `dotnet/Foxwarm.Tests/Telemetry/OtlpTraceTests.cs`

Secondary files: `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/Sessions/Turns/SessionTurnRunner.cs`, `dotnet/Foxwarm/Models/ModelRequestOwner.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.cs`, `packages/shared/src/configSchemas.ts`

Operator configuration and content controls are documented in `docs/otlp-tracing.md`.

## Runtime and delivery

`MainHost` owns the exporter in console and Desktop builds, including headless Main. `OtlpConfiguration.Capture` validates the same app settings on startup and supported config saves. `FoxwarmTraces.Open` resolves only the OTLP header references when Main starts. Startup with an unavailable header secret leaves tracing disabled. Settings and credentials are recaptured on restart. The exporter listens to the Foxwarm activity source and filters by the owning source instance before enqueueing. The OpenTelemetry .NET batch processor owns the bounded queue and sends completed spans over HTTP protobuf. Main drains accepted work before a bounded exporter shutdown.

`SessionTurnRunner` starts a root after selecting a foreground input batch or a validated Continue. Session identifiers group independent traces. A Stop accepted before turn settlement records cancellation even when the committed assistant result returns normally. Same-owner model and tool spans choose the closest Foxwarm ancestor in the current execution context. Independent work starts its own trace. `ModelRequestOwner` creates an attempt span after the provider adapter prepares its semantic payload and the journal admission settles. Preparation failures before this point produce no call span. Setup connection tests use their separate journal path and do not emit Session model spans. Retry and failover use the same attempt boundary. `SessionToolExecutor` owns attributed local, Node and MCP spans, including operations which fail before dispatch. MCP result envelopes with `isError: true` record failure. `LocalSessionTurnHost.ExecuteToolBatchAsync` forwards calls that settle without reaching the executor to the same instrumentation.

`FoxwarmTraces.GenAi` projects fields following the OpenTelemetry 1.41.1 GenAI conventions. Message history comes from supported provider request formats, and response content comes from `ChatResult` and its committed segments. Output messages use `tool_call` for tool calls and `length` for token or context limits. Input-token totals combine the app's uncached and cached usage. Custom outcomes, attempt metadata and the actual tool dispatch flag use `foxwarm.*`. Content settings are applied before enqueue. The exporter captures only selected semantic fields and adds no new redaction stage. Bounded JSON remains parseable when shortened.

`OtlpTraceTests` exercises a real headless Main, synthetic model and local protobuf receiver. It verifies configuration, selected content, retries, tool results, and the resulting span hierarchy.
