# Thread: ToolScript execution

## Producer to consumer path

```text
Model tool call / explicit Session tool
  -> ToolScriptToolDefinitions + ToolRegistry authorization
  -> SessionToolExecutor.ToolScript
  -> MainToolScript / MontyWorker frame + host-call loop
  -> ToolScriptRunStore record/result
  -> Session owner/tool result and WebUI tool timeline
```

- **Producer:** `UnifiedTools` exposes a bounded ToolScript definition; model or an authorized caller supplies script/value/input under request/session scope.
- **Owner:** `SessionToolExecutor` admits the call; `MainToolScript` owns run lifecycle; `MontyWorker` owns execution/suspension; budget/context types own instruction/data/output limits; `ToolScriptRunStore` owns durable run metadata.
- **Durable boundary:** ToolScript records persist status/result/error/host-call lifecycle through `ToolScriptRecordJson`; Session changes requested by host calls still go through SessionManager/save lane/authority. Run records are not Session history or child-handoff receipts.
- **Consumers:** host-call results resume Monty frames; final ToolScript result returns to `LocalSessionTurnHost` and model tool timeline; WebUI progress reads explicit realtime/tool records.

## Ordering and failure behavior

Authorization precedes host calls. Budget exhaustion, cancellation, malformed values, host-call failure, and worker crash produce typed incomplete/error results; effects already committed through a host call remain committed and are not falsely rolled back by the script record. Main shutdown drains/terminates workers before disposal. Current implementation is Main-local; managed child/receipt/task migration is not implied.

## Canonical units and tests

- [ToolScript runtime](../units/toolscript.md)
- [Unified tools](../units/tools-registry.md)
- [Tool authorization](../units/tool-authorization.md)
- `dotnet/Foxwarm.Tests/ToolScript/*`, ToolScript budget/record/host-call tests.
