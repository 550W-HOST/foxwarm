# Unit: .NET developer tools

Files: `dotnet/Foxwarm.DevTools/`

## Purpose

Provides developer-facing command entry points for Responses request/stream probes, journal inspection, conditional-memory inspection, and Session restart/persistence probes without becoming part of the Main runtime.

## Stable symbols and callers

`Foxwarm.DevTools.Program` selects command verbs; `ResponsesRequestCommand`/`ResponsesStreamCommand` call provider request adapters; `JournalCommand` reads the request journal; `ConditionalMemoryCommand` reads memory selection; `SessionRestartCommand` exercises startup/load behavior.

## Contract and side effects

Commands use the same source contracts but should not be treated as production consumers. Probe writes/fixtures must not be described as a second authority; command output is bounded/debug-facing and does not change the WebUI/Main route boundary.

## Tests

Covered indirectly by model/journal/memory/session persistence tests. The command project is declared in `dotnet/Foxwarm.sln` and references `Foxwarm`.
