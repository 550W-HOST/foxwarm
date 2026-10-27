# Unit: Main date-directory log rotation

Files: `dotnet/Foxwarm/LogRotation.cs`, `dotnet/Foxwarm.Tests/LogRotationTests.cs`

Secondary/integration references: `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm/Sessions/AgentCatalog.cs`, `src/logRotation.ts`, `src/index.ts`, `packages/webui/test/mainHostNativeExec.e2e.mjs`

## Contract and rationale

### D-main-date-log-rotation

Main translates Source `rotateDatedLogs`, `runLogRotation` and ordinary startup scheduling: retain the three newest `YYYY-MM-DD` directories and seven newest `.tar.gz` archives, sorted by name; run at startup and every ten hours. Only successful archival permits removal of the original directory. Archive failure retains the original and permits later dates to be attempted. Removal or archive-retention failure ends that root's pass through the existing logged failure boundary.

This artifact policy is independent of the [strict 24-hour exec tracking lifetime](./shared-persistent-exec.md#d-persistent-exec-completion-event-retention). It does not query active jobs, protect arbitrarily long commands, extend notification retention or delete commands through process control. Open descriptors and later path-based sidecar writes retain their platform behavior. No active-job protection table or additional cleanup authority is introduced.

## Owners and effects

- `MainHost.StartAsync` starts one `LogRotation` after ordinary host/channel startup. Its owned schedule performs the immediate pass and then ten-hour ticks. Shutdown stops future ticks and drains the current pass.
- `RunAsync` rotates the selected data root's `state/logs`, then each actual Agent `.temp/exec` root. `AgentCatalog.ExecLogRoots` maps its configured canonical Agent root or the existing explicit retained workspace layout; it does not guess other target namespaces.
- `RotateDatedLogsAsync` considers real date directories and regular archive files, excluding directory symlinks as Source directory-entry enumeration does. The archives contain the original date directory and its contents. `recent`, error directories, registry files and unrelated names remain outside date rotation. Production of raw model diagnostics and the separate recent-file count policy have other owners.
- .NET BCL `TarFile` plus `GZipStream` replaces the Source external `tar` process so the same policy has a native Windows implementation without adding a Node/Python helper or assuming a Unix tar executable. Compression occurs outside the host's synchronous startup work; the result is awaited before source deletion.

## Verification

`LogRotationTests` checks original archive contents, three/seven retention, skipped names, a real destination-open failure with original retention and subsequent successful archival, and the owned immediate schedule over only supplied roots. `mainHostNativeExec.e2e.mjs` exercises actual Main startup archival alongside native command lifetime and real process restart. Linux evidence does not qualify Windows sharing/deletion or PowerShell execution.
