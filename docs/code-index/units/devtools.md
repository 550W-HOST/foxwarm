# Unit: .NET developer tools

Files: `dotnet/Foxwarm.DevTools/CatalogFixtureCommand.cs`, `dotnet/Foxwarm.DevTools/ConditionalMemoryCommand.cs`, `dotnet/Foxwarm.DevTools/JournalCommand.cs`, `dotnet/Foxwarm.DevTools/MainLogFixtureCommand.cs`, `dotnet/Foxwarm.DevTools/Program.cs`, `dotnet/Foxwarm.DevTools/ResponsesRequestCommand.cs`, `dotnet/Foxwarm.DevTools/ResponsesStreamCommand.cs`, `dotnet/Foxwarm.DevTools/SessionRestartCommand.cs`

## Purpose

Provides developer-facing command entry points for Responses request/stream probes, journal inspection, conditional-memory inspection, and Session restart/persistence probes without becoming part of the Main runtime.

## Stable symbols and callers

`Foxwarm.DevTools.Program` selects command verbs; `ResponsesRequestCommand`/`ResponsesStreamCommand` call provider request adapters; `JournalCommand` reads the request journal; `ConditionalMemoryCommand` reads memory selection; `SessionRestartCommand` exercises startup/load behavior; `CatalogFixtureCommand` prepares owned browser-fixture membership through the maintained `SessionCatalog` API.

## Contract and side effects

Commands use the same source contracts but should not be treated as production consumers. Probe writes/fixtures must not be described as a second authority; command output is bounded/debug-facing and does not change the WebUI/Main route boundary.

`ResponsesStreamCommand` observes typed cumulative progress with absent nullable part fields omitted; zero indices and empty text remain present. This projection applies only to progress-part DTOs, not provider-owned completion/unknown JSON or the comparator's field-presence checks. Part creation and event ordering remain observable, including a part whose text has not arrived.

`SessionRestartCommand` has fixed identity-copy-before, identity-copy-after and identity-finishing checkpoints for actual child termination, plus identity-recover for normal startup over the retained journal. The checkpoint is selected before construction by the developer command; it writes its result and stays pending until its test parent terminates the child. These scenarios use the existing manager callback, not a Main runtime fault channel. Recovery checks run in fresh processes without installed callbacks.

`catalog-fixture <upsert|replace> ROOT ROWS_JSON` writes only catalog membership/projections in an owned fixture root. Replace removes omitted members through the catalog owner before upserting the supplied rows. Execution-context and timer-lifecycle browser scenarios use it while their hosts are stopped; legacy Archive branch seeding remains a separate Source producer.

`mainlog-fixture ROOT MODE` runs concurrent ordinary Console writers and flushes through the real Main capture. Startup diagnostics tests own its configuration, routing environment, optional failing file device and process deadline; the command records completed-file visibility before disposal and exercises retained writer references afterward. Producer locking and logging consequences belong to [Main Logs](./dotnet-webui-logs.md#real-producer-and-lifetime).

## Tests

Covered indirectly by model/journal/memory/session persistence tests. The command project is declared in `dotnet/Foxwarm.sln` and references `Foxwarm`.
