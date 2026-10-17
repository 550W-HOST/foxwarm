# Unit: Session manager Agent, setup, files, knowledge, waits, and compaction

Files: `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Sessions/SessionManager.AgentTools.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Authorization.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Compact.cs`, `dotnet/Foxwarm/Sessions/SessionManager.FileDelivery.cs`, `dotnet/Foxwarm/Sessions/FileDeliveryArtifact.cs`, `dotnet/Foxwarm/Sessions/SessionManager.InboundFiles.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Knowledge.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Settings.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Setup.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Wait.cs`

## Purpose

Delegates authenticated Main operations for Agent setup/knowledge/memory, Session settings, file delivery/inbound files, waits, compaction, and authorization to exact owners and feature services.

## Stable methods and callers

Agent/setup methods load/validate Agent metadata and provider forms; knowledge/memory methods select/update Agent resources; file methods validate ownership/path and create delivery refs; settings methods stage model/display/cwd changes through save-lane operations; wait/compact methods call owner safe points and return explicit committed/accepted outcomes.

## Contract and side effects

This unit is an orchestration boundary. It does not write active JSON/Archive outside `SessionSaveLane`, does not make catalog rows semantic history, and does not turn setup Vector fields into runtime Vector admission. File export/delivery and bound-Agent ingress use the [external Node file consumers](./external-node-files.md) without moving Session/image authority off Main. File delivery is authenticated/deployment-relative; memory/knowledge selection affects future prompt input, not past history.

`InstallConfigAsync` resolves/captures one regular candidate through the existing read/path boundary, checks both `set_config` and Main read authority, then reauthorizes inside the configuration installation lane. Native validation errors do not expose candidate content. `wait` with exact owned `waitExecIds` defaults to one 600-second fallback unless input waiting or an explicit null disables that fallback; explicit positive fallback values remain unchanged.

`SendFileAsync` preserves the existing destination/path/Node authorization and staging owners. It returns a bounded version-1 `fileDelivery` value only after at least one actual delivery succeeds. `FileDeliveryArtifact.Create` prepares original basename/MIME/size, exact canonical Session or direct channel target, unique delivery ID, source Node and actual Main staging path under the [shared receipt contract](./shared-file-delivery.md). Remote receipts retain the transfer payload MIME, using the ordinary extension fallback only when no MIME was supplied; receipt metadata does not change download/preview authorization. The structured receipt survives direct tool values and nested ToolScript return values; failed sends and unrelated image exports do not gain receipts. No extra queue row, target history message or notification accompanies delivery.

## Tests

Agent/knowledge/setup, file-delivery, wait, compact, authorization, settings, and Session manager operation tests.

`MainFileDeliveryTests` and the native nested-delivery test in `MainToolScriptTests` cover successful structured receipts, failure exclusion, destination identity and unchanged history/queue. The original-App continuous/download driver checks target filtering and native downloads; `experimentHostNodeFiles.e2e.mjs` checks direct/nested receipt provenance and real staging through official CLI clients.
