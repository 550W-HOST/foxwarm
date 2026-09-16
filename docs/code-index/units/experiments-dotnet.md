# Unit: experiments/dotnet

Files: experiments/dotnet/Foxwarm.DotnetSpike.sln, experiments/dotnet/Foxwarm.ConditionalMemory/, experiments/dotnet/Foxwarm.MessageJson/, experiments/dotnet/Foxwarm.ConditionalMemory.Tests/, experiments/dotnet/parity-corpus.json, experiments/dotnet/README.md

## Purpose

Contains a limited, manual ordinary-.NET migration prototype. The first port is the pure conditional-memory module only; it is an experiment for discovering language and runtime migration issues, not an alternate Foxwarm runtime.

## Scope

The C# library ports the pure filtering and current-model snapshot header helpers from [src-conditional-memory](./src-conditional-memory.md), preserving the confirmed bounded grammar and byte-level newline/header behavior. Phase 2A adds an owned JSON-backed compatibility leaf for canonical Message/MessagePart values, exact-false model visibility, and `src/toolCallArgs.ts` parsing/stringification; full provider Responses conversion remains out of scope. A 53-case shared corpus is run through both the actual TypeScript helpers and C# helpers by an explicit manual differential runner; undefined results are represented explicitly. The expanded Phase 2A corpus currently exposes native parser diagnostic-text differences for malformed argument strings; the harness does not normalize them away. TypeScript remains authoritative, and the prototype is outside the normal Node build and test dependency graph. It does not port Session workers, persistence, model routing, provider transport, or runtime snapshot ownership.

The next-module inventory is intentionally deferred: canonical Message/MessagePart JSON/provider serialization, Responses SSE incremental parsing/cancellation with a local fake provider, and a disposable-database LanceDB native binding probe. Each may require non-mechanical contract decisions before implementation.

## Integration

This prototype has no production integration. Run its tests manually from `experiments/dotnet` with `dotnet test Foxwarm.DotnetSpike.sln` when a private .NET SDK is available.
