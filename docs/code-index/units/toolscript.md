# Unit: Main ToolScript runtime

Files: `dotnet/Foxwarm/ToolScript/MainToolScript.Execution.cs`, `dotnet/Foxwarm/ToolScript/MainToolScript.HostCalls.cs`, `dotnet/Foxwarm/ToolScript/MainToolScript.cs`, `dotnet/Foxwarm/ToolScript/MontyFrameBudget.cs`, `dotnet/Foxwarm/ToolScript/MontyValues.cs`, `dotnet/Foxwarm/ToolScript/MontyWorker.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptBudgetBuffer.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptContext.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptDataBudget.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptRecordJson.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptRunStore.cs`

## Purpose

Runs bounded Monty scripts in Main, handles host calls and suspension, records durable run metadata, and serializes script ownership per Session/lane.

## Stable methods and callers

- `MainToolScript.RunAsync` admits a script with Session/agent/request scope and drives `MontyWorker` until completion, host-call suspension, cancellation, budget exhaustion, or failure.
- `MainToolScript.Execution` converts Monty values/call frames into host operations; `HostCalls` routes approved tool/session calls through `UnifiedTools`/SessionManager rather than direct filesystem authority.
- `MontyFrameBudget`, `ToolScriptBudgetBuffer`, and `ToolScriptDataBudget` bound instructions, output, memory/data, and nested host-call payloads.
- `ToolScriptContext` carries stable run/session identity; `ToolScriptRecordJson` serializes lifecycle records; `ToolScriptRunStore` persists/reloads current run status and result for inspection/resume rules.

## Contract and side effects

ToolScript is Main-local and bounded. A script does not bypass tool authorization, Session owner/save-lane ordering, or normal file/exec boundaries. Durable run metadata is not a child-handoff receipt and does not imply managed-child/task migration. Cancellation preserves whether host effects happened before the script stopped.

## Tests

`dotnet/Foxwarm.Tests/ToolScript/*`; `MainLocalToolsTests.cs`; budget/host-call/record persistence tests.
