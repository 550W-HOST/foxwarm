# Unit: Main ToolScript runtime

Files: `dotnet/Foxwarm/ToolScript/MainToolScript.Execution.cs`, `dotnet/Foxwarm/ToolScript/MainToolScript.HostCalls.cs`, `dotnet/Foxwarm/ToolScript/MainToolScript.cs`, `dotnet/Foxwarm/ToolScript/MontyFrameBudget.cs`, `dotnet/Foxwarm/ToolScript/MontyValues.cs`, `dotnet/Foxwarm/ToolScript/MontyWorker.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptBudgetBuffer.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptContext.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptDataBudget.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptRecordJson.cs`, `dotnet/Foxwarm/ToolScript/ToolScriptRunStore.cs`

## Purpose

Runs Main-local Monty ToolScript slices, routes the supported host calls, persists run records and opaque waiting snapshots, and resumes or cancels owner-scoped runs without bypassing normal tool/Session boundaries.

## Stable methods and callers

- `MainToolScript.ExecuteAsync` admits one operation while shutdown is open; `StartAsync`, `ContinueAsync`, `RequiredAsync`, `CancelAsync`, `BeginShutdown`, `DrainAsync`, and `DisposeAsync` own start/continue/read/cancel/process-lifecycle behavior.
- `MainToolScript.RunAsync` and its `ProjectSlice` closure (the Execution partial) drive one configured worker or snapshot continuation and publish trusted current-slice subcalls, including an empty list, with the lean outer execution result; `MainToolScript.HostCallAsync` (the HostCalls partial) admits `call_tool`, `ask_agent`, and `request_model_without_context`, records subcalls, and returns progress/results through `ToolScriptContext`.
- `MontyWorker.ConfigureAsync`, `TurnAsync`, `Kill`, and `DisposeAsync` own the native Linux x64 Monty 0.0.19 subprocess protocol and watchdog; waiting runs retain snapshots rather than a live worker. `IsSupported` gates Main ToolScript discovery on Linux x64. Worker creation is lazy, so Windows desktop startup does not require or launch Monty.
- `MontyFrameBudget.Parse`/`Preflight` inspect the fixed protobuf envelope before generated materialization: each frame is capped at 256 MiB and protocol nesting at depth 100.
- `ToolScriptDataBudget.Charge`, `Retain`, `JsonPreflight`, `ParseJson`, `JsonValue`, and `ReadRecordAsync` charge conservative per-activity materialization; `ToolScriptStdout.Append` enforces the cumulative 64 MiB UTF-8 stdout limit. `ToolScriptBudgetBuffer` charges incremental JSON tokens while serializing opaque values.
- `ToolScriptRecordJson.Write` streams bounded record JSON; `ToolScriptRunStore.AcquireAsync`, `ReadAsync`, `ListAsync`, `WriteAsync`, `RequireOwned`, and `RequireUnmanaged` serialize per-run access, owner checks, durable record writes, and managed-run refusal.

Callers: `SessionToolExecutor.ToolScript`, `ToolScriptToolDefinitions`, `SessionManager.ToolScript`, and WebUI/tool timeline consumers. The interpreter is Main-local even when source is fetched from a selected external Node through the [whole-file consumer](./external-node-files.md). Managed child-session host functions are explicitly unsupported in this host.

## Budget and worker contract

`MontyFrameBudget` is a fixed-protocol preflight, not an instruction budget, global RSS limit, or process sandbox. `MontyWorker.ConfigureAsync` passes Monty limits of 64 MiB native memory, recursion depth 200, and the requested duration; `TurnAsync` uses a watchdog and kills the worker on timeout/protocol failure. `ToolScriptDataBudget` is a conservative programmatic materialization budget (default 1 GiB) covering JSON values, frame/request bytes, retained stdout/snapshot representations, and record serialization. `ToolScriptStdout` separately caps cumulative host output at 64 MiB.

These budgets account for allocations Foxwarm materializes or retains; they do not claim to bound the whole OS process. Completed host effects and durable records remain when a later budget/cancellation failure occurs.

## Waiting, restart, and cancellation

`ask_agent` and timeout-safe host-call suspension write `waiting`, `snapshotBase64`, continuation metadata, and VM identity into the owner record. `ContinueAsync` requires the exact owner, continuation ID, `@pydantic/monty` version `0.0.19`, and snapshot format `monty-pool-snapshot-v0.0.19`; it loads the snapshot into a fresh worker and retains incompatible historical record/snapshot instead of converting it. Completed/current-runtime failed/cancelled records remove resumable snapshot state. Main-managed wait records are rejected by `RequireUnmanaged`, while unsupported managed-session functions fail without importing child state.

Active cancellation requests the run token and lets the worker/host-call boundary settle. It does not roll back already committed tool, Session, file, or process effects. `BeginShutdown` rejects new operations; `DrainAsync` waits for admitted activity and worker disposal while leaving persisted records intact.

## Host-call boundary

`HostCallAsync` accepts only the supported names and normalizes `call_tool` descriptors into the unified tool path. Filesystem, exec, terminal, MCP, Node, Session, and authorization effects remain behind their ordinary tools/owners; Monty OS functions and mounts are not exposed. `request_model_without_context` uses the current owner’s prompt-cache/effort boundary and returns normalized text/parts, while ToolScript records keep run metadata separate from outer Session history. `ToolScriptContext.CallTool` carries nullable JSON source values through the ordinary Session executor; [MCP values and trusted control](../threads/tools-permissions-and-exec.md#outbound-mcp-values-and-trusted-control) govern the projection boundary.

`filePath` source uses the captured invocation Node/cwd, whole bytes and strict UTF-8/source-budget checks. A snapshot continuation does not refetch a changed source file; nested calls retain current-owner dispatch and authorization after Node selection changes.

Short `call_tool` strings containing a qualified ID, such as `node:master/read` or `builtin:task`, use the same concrete registry path as descriptor calls. Cancellation is checked before host-call/tool admission and again after asynchronous authorization. Stop settles a launched exec wait without killing its shell, and no later script host effect is admitted. Both existing run modes still execute the initial segment before returning; waiting/time-budget pauses require explicit continuation in either mode.

## Tests

`dotnet/Foxwarm.Tests/ToolScript/MainToolScriptTests.cs`; `ToolScriptBudgetTests.cs`; `ToolScriptHostTests.cs`; `ToolScriptLifecycleTests.cs`; `ToolScriptOwnershipTests.cs`; `ToolScriptRecordJson`/snapshot/cancellation coverage.
