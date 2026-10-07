# Unit: WebUI channel registration and shared DTO contract

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUiContract.cs`

## Purpose

Registers the .NET WebUI route surface and defines shared request/response/event DTOs, route limits, deployment-relative identifiers, and host-to-client compatibility shapes.

## Stable methods and callers

`WebUIChannel.Register` composes route groups and injects `SessionManager`, `SessionRuntime`, `TaskService`, `ImageBlobStore`, `TerminalRegistry`, `CodeWorkbench`, and realtime publisher dependencies. `WebUiContract` owns parsing/serialization helpers and bounded pagination/operation results consumed by all partial route units and React WebUI units.

## Contract and side effects

Routes are registered behind `HttpServer` normal auth. DTO validation precedes manager/runtime calls; this file does not write Session JSON, Archive, or catalog directly. Accepted/committed/partial failures retain explicit status fields for browser state reconciliation.

## Tests

`WebUiStartupTests.cs`; route contract/serialization fixtures; all partial WebUI route tests.
