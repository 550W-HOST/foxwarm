# Unit: Speech proxy

Files: `dotnet/Foxwarm/Asr/AsrProxy.Stream.cs`, `dotnet/Foxwarm/Asr/AsrProxy.cs`

## Purpose

Streams uploaded audio to the configured ASR backend and translates failures into the host API contract.

## Stable symbols and callers

`AsrProxy`; streaming frame loop.

Callers and adjacent boundaries: WebUIChannel setup/audio routes.

## Tests

dotnet/Foxwarm.Tests/Channels/AsrRoutesTests.cs and partial fixtures.
