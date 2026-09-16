# Experimental .NET prototype

This directory is a manual migration experiment and is not part of the Node.js build or test dependency graph. It contains ordinary .NET 10 projects for focused contract probes:

- `Foxwarm.ConditionalMemory` ports the pure conditional-memory helpers.
- `Foxwarm.MessageJson` is an owned `JsonObject` compatibility leaf for supported canonical messages and tool arguments.
- `Foxwarm.OpenAIResponses.Streaming` ports one complete, transport-neutral OpenAI Responses event accumulator plus an async SSE collector. It is not a provider client: request construction, authentication, retries, routing, timeouts/watchdogs, WebSocket pooling, journaling, Session ownership, final `Message` conversion, and runtime integration remain outside the experiment.

## Build and tests

With the private .NET 10 SDK selected:

```sh
export DOTNET_ROOT=/path/to/private/dotnet-sdk-10
export PATH="$DOTNET_ROOT:$PATH"
dotnet restore experiments/dotnet/Foxwarm.DotnetSpike.sln
dotnet test experiments/dotnet/Foxwarm.DotnetSpike.sln --no-restore
```

The Responses collector uses native async `Stream.ReadAsync`, incremental UTF-8 decoding, source-equivalent narrow SSE framing, and explicit `StreamOwnership.Dispose` (the default) or `LeaveOpen`. The accumulator owns retained input JSON by deep clone and emits cumulative progress, meaningful-progress, safety-buffering, decoded-text, and complete-block callbacks. Typed semantic terminal, malformed-event, read, EOF, and normal .NET cancellation categories are covered by independent xUnit tests. The loopback cancellation test proves accepted/requested/held/cancelled/connection-closed milestones without sleep-based synchronization; it does not contact a provider and does not restart a runtime.

## Differential oracle

The existing Phase 2A `parity-corpus.json`, categories, and runner remain unchanged. Responses streaming has a separate 9-case corpus at `responses-stream-corpus.json`. It invokes the actual TypeScript `collectOpenAIResponsesStream` with the exact synthetic string/Buffer chunks and compares it with the C# collector over the same UTF-8 bytes. The comparator requires equal corpus/TS/C# lengths and exact semantic equality for final response JSON, every cumulative progress snapshot, meaningful-progress count, safety metadata, concatenated decoded raw text, complete SSE blocks, and normalized success/error categories and terminal fields. It also rejects missing completion, wrong progress/event counts, and late terminal errors. Native malformed-parser and low-level read diagnostics are intentionally not required to be byte-identical.

Run the separate Responses differential check from the repository root:

```sh
export DOTNET_ROOT=/path/to/private/dotnet-sdk-10
export PATH="$DOTNET_ROOT:$PATH"
python3 experiments/dotnet/responses-stream-parity-compare.py dotnet
```

The TypeScript subprocess is bounded and its JSON prefix is parsed because importing the real provider module can retain process-local logging handles after the oracle result is written. `FOXWARM_NO_CONSOLE_LOG=1` is applied by the wrapper; no provider request is made. The expected result is:

```text
comparison ok: 9 cases; semantic final/progress/raw/block/error parity exact
```

Run the preserved Phase 2A differential oracle separately with `python3 experiments/dotnet/run-parity.py` after the repository JavaScript dependencies and shared generated package are available. The prototype remains outside normal Node CI and does not alter TypeScript runtime behavior, persistence, model routing, or Session ownership.
