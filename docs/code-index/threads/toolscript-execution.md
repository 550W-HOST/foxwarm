# Thread: ToolScript execution, budgets, waits, and effects

## Producer to consumer path

```text
Model/tool request
  -> ToolScriptToolDefinitions + ToolRegistry authorization
  -> SessionToolExecutor.ToolScript
  -> MainToolScript.ExecuteAsync / StartAsync
  -> MontyWorker.ConfigureAsync + TurnAsync
  -> HostCallAsync -> unified tools / owner services
  -> ToolScriptRunStore.WriteAsync
  -> LocalSessionTurnHost result + WebUI progress/timeline
```

- **Producer:** an authorized model or caller supplies inline/file code and JSON input under the current Session/Agent context.
- **Owner:** `SessionToolExecutor` admits the operation; `MainToolScript` owns run lifecycle and cancellation; `MontyWorker` owns the native protocol worker; `ToolScriptDataBudget`/`MontyFrameBudget` own materialization and frame preflight; `ToolScriptRunStore` owns per-run durable records.
- **Durable boundary:** `ToolScriptRecordJson` streams run status/result/error/host-call fields through `LinuxAtomicJsonFile`. Waiting state stores opaque `snapshotBase64`, continuation metadata, stdout, and VM identity. Session changes requested by host calls still go through SessionManager/save-lane/authority; a run record is not Session history or a child-handoff receipt.
- **Consumers:** host-call results resume the worker or become the final tool result; LocalSessionTurnHost appends only the outer canonical tool result; WebUI receives explicit progress/timeline updates.

## Budget boundaries

`MontyFrameBudget.Preflight` parses the fixed protobuf envelope before generated materialization, rejecting frames above 256 MiB or nesting at depth 100. This is a frame/protocol preflight, not a global RSS or instruction sandbox. `MontyWorker.ConfigureAsync` passes Monty’s native 64 MiB memory, recursion-depth 200, and requested-duration limits; `TurnAsync` uses a watchdog and kills the worker when its duration expires.

`ToolScriptDataBudget` charges conservative programmatic materialization (default 1 GiB): JSON input/records, protocol request/reply bytes, retained stdout/snapshot representations, and streaming record serialization. `ToolScriptStdout` separately caps cumulative UTF-8 stdout at 64 MiB. These budgets cover Foxwarm materialized/retained data, not whole-process memory. A later budget/cancellation failure does not roll back effects already committed by a host call.

## Waiting, restart, and cancellation

`ask_agent` and timeout-safe host-call suspension persist `waiting`, `snapshotBase64`, pending return/exception data, continuation ID, stdout, and exact Monty runtime identity. `ContinueAsync` requires owner and continuation-ID matches plus Monty `0.0.19`/`monty-pool-snapshot-v0.0.19`; it loads the snapshot into a fresh worker, so waits survive process/worker replacement. Unsupported or incompatible snapshots retain historical records and snapshot bytes instead of conversion. Managed-session records are rejected by `RequireUnmanaged` on this Main host.

Active `CancelAsync` requests the run token; the worker/host-call boundary settles, and already committed Session/file/exec/tool effects remain committed. `BeginShutdown` rejects new operations; `DrainAsync` waits admitted activity and worker disposal without deleting persisted records.

## Host effects and result shaping

`HostCallAsync` exposes only `call_tool`, `ask_agent`, and `request_model_without_context` here. `call_tool` normalizes shorthand/descriptors into the unified registry/authorization path; Monty OS functions and mounts are not exposed. `request_model_without_context` uses the current owner’s prompt-cache/effort boundary and returns normalized text/parts; promoted image references stay in the shared image store rather than run JSON/base64/text. Nested calls publish progress and are retained in the run record, not appended as ordinary outer-session tool history.

## Canonical units and tests

- [ToolScript runtime](../units/toolscript.md)
- [Unified tools](../units/tools-registry.md)
- [Tool authorization](../units/tool-authorization.md)
- `MainToolScriptTests`, `ToolScriptBudgetTests`, `ToolScriptHostTests`, `ToolScriptLifecycleTests`, `ToolScriptOwnershipTests`.
