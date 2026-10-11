# Unit: Session manager Agent, setup, files, knowledge, waits, and compaction

Files: `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Sessions/SessionManager.AgentTools.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Authorization.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Compact.cs`, `dotnet/Foxwarm/Sessions/SessionManager.FileDelivery.cs`, `dotnet/Foxwarm/Sessions/SessionManager.InboundFiles.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Knowledge.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Settings.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Setup.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Wait.cs`

## Purpose

Delegates authenticated Main operations for Agent setup/knowledge/memory, Session settings, file delivery/inbound files, waits, compaction, and authorization to exact owners and feature services.

## Stable methods and callers

Agent/setup methods load/validate Agent metadata and provider forms; knowledge/memory methods select/update Agent resources; file methods validate ownership/path and create delivery refs; settings methods stage model/display/cwd changes through save-lane operations; wait/compact methods call owner safe points and return explicit committed/accepted outcomes.

## Contract and side effects

This unit is an orchestration boundary. It does not write active JSON/Archive outside `SessionSaveLane`, does not make catalog rows semantic history, and does not turn setup Vector fields into runtime Vector admission. File delivery is authenticated/deployment-relative; memory/knowledge selection affects future prompt input, not past history.

`InstallConfigAsync` resolves/captures one regular candidate through the existing read/path boundary, checks both `set_config` and Main read authority, then reauthorizes inside the configuration installation lane. Native validation errors do not expose candidate content. `wait` with exact owned `waitExecIds` defaults to one 600-second fallback unless input waiting or an explicit null disables that fallback; explicit positive fallback values remain unchanged.

## Tests

Agent/knowledge/setup, file-delivery, wait, compact, authorization, settings, and Session manager operation tests.
