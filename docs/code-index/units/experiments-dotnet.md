# Unit: experiments/dotnet

Files: experiments/dotnet/Foxwarm.DotnetSpike.sln, experiments/dotnet/Foxwarm.ConditionalMemory/, experiments/dotnet/Foxwarm.MessageJson/, experiments/dotnet/Foxwarm.OpenAIResponses.Streaming/, experiments/dotnet/Foxwarm.ConditionalMemory.Tests/, experiments/dotnet/Foxwarm.OpenAIResponses.Streaming.Tests/, experiments/dotnet/Foxwarm.OpenAIResponses.Streaming.Parity/, experiments/dotnet/parity-corpus.json, experiments/dotnet/parity-ts.ts, experiments/dotnet/responses-stream-corpus.json, experiments/dotnet/responses-stream-parity-ts.ts, experiments/dotnet/responses-stream-parity-compare.py, experiments/dotnet/run-responses-stream-ts.py, experiments/dotnet/parity_compare.py, experiments/dotnet/parity_compare_checks.py, experiments/dotnet/run-parity.py, experiments/dotnet/run-ts-parity.py, experiments/dotnet/README.md

## Purpose

Contains a limited, manual ordinary-.NET migration prototype. The conditional-memory and owned Message/MessagePart JSON leaves are pure compatibility probes. The Responses streaming project is one complete provider-event collection component, not an alternate Foxwarm runtime or production provider.

## Scope

The C# libraries port the confirmed pure conditional-memory helpers, a bounded owned JSON compatibility leaf for canonical Message/MessagePart values and tool arguments, and the OpenAI Responses stream collector boundary. `Foxwarm.OpenAIResponses.Streaming` has two internal layers: `ResponsesEventAccumulator` consumes one owned `JsonObject` event synchronously and reconstructs indexed output/content/reasoning/refusal/function-call/annotation/hosted-item/phase state with completed-response enrichment; `ResponsesSseCollector` performs ordinary async `Stream.ReadAsync` byte reads, incremental UTF-8 decoding, source-specific `\n\n` SSE framing, decoded/raw-block callbacks, explicit stream ownership, prompt cancellation disposal, and typed semantic terminal/read/EOF/malformed/cancellation categories. Unknown provider fields are retained, final output is owned, progress snapshots are cumulative, and timers/watchdogs are excluded.

The stream component deliberately stops before HTTP request construction/authentication, retries/routing, timeout policy, WebSocket transport/pooling, request journaling, Session/process/runtime ownership, persistence, and final canonical `Message` conversion. The deterministic loopback test is test-only and proves held-body cancellation/disposal and connection close; it makes no provider call.

The existing Phase 2A `parity-corpus.json` and comparison categories are unchanged. A separate 9-case `responses-stream-corpus.json` drives the actual TypeScript `collectOpenAIResponsesStream` with exact synthetic chunks and the C# collector over identical UTF-8 bytes. The comparator requires equal corpus/TS/C# lengths and exact semantic final JSON, cumulative progress sequence, meaningful count, safety metadata, concatenated decoded raw text, complete SSE blocks, and normalized success/error/terminal fields. Negative checks reject wrong final/progress/block counts, unobserved completion, and late terminal errors. Native malformed-parser/read diagnostics may differ only where the approved design allows it.

## Integration

This prototype has no production integration. Run its tests manually with a private .NET 10 SDK:

```sh
dotnet test experiments/dotnet/Foxwarm.DotnetSpike.sln --no-restore
python3 experiments/dotnet/responses-stream-parity-compare.py dotnet
python3 experiments/dotnet/run-parity.py
```

The TypeScript oracle wrapper bounds provider-module process handles and suppresses console logging; neither oracle uses credentials or live sessions. No runtime restart is required because this is an experiment-only change.
