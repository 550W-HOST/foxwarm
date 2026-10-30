# Unit: windows-service-scripts

Files: scripts/windowsService.js, scripts/windowsService.test.js, scripts/start.ps1, scripts/restart.ps1, scripts/stop.ps1, scripts/status.ps1, dotnet/Foxwarm/WindowsBackgroundControl.cs
Secondary files: package.json, install-foxwarm.ps1, README.md

## Purpose

Provides native Windows build, background start, restart, status, and stop workflows without requiring Bash or tmux.

## Behavior

- Root builds remove obsolete generated files through Node filesystem APIs so the build command works in both POSIX shells and Windows `cmd.exe`. Full builds use checked-in lock files through `npm ci` and do not rewrite dependency manifests.
- Windows start and the Windows installer refuse an existing instance before their lockfile install and full build. Restart builds against the installed dependency tree into separate staging, then stops Main, promotes the complete output and launches the selected runtime. It does not run npm ci; changed lockfiles require stop followed by start. Managed/native output is never overwritten in place. The shared source build owner uses a directory junction for `runtime/current`, and launch resolves its stable real path. PowerShell wrappers support `-SkipBuild` for the already selected runtime.
- The background launcher resolves the data root with the same environment, pointer-file, and checkout fallback precedence as application configuration. It normalizes the selected installation/data roots before opening logs, naming control or injecting the child's data override, so a relative explicit application root is not rebased twice by the managed host.
- Lifecycle logs are appended under `<data-root>/state/logs/`.
- A data-root-specific local named pipe reports status and requests shutdown. The JavaScript start client selects the existing data-root-specific name and detaches the actual managed Main with append log descriptors. Managed `WindowsBackgroundControl` owns that pipe in its private background entry, returns the managed PID/log/status shape and requests `IHostApplicationLifetime.StopApplication` on stop. It remains available through ordinary Main drain, including HTTP-disabled operation. There is no Node in-process signal emulation, HTTP-only replacement, PID ledger or new service principal.
- Control replies retain the Source JSON-plus-EOF completion contract. Each connected server instance drains its Windows output and closes its handle rather than forcibly disconnecting/reusing it; a pending successor keeps the pipe name available. The JavaScript client still requires ordinary complete-response EOF and propagates transport/parse failures. This preserves existing clients and does not turn a partial/error reply into success.
- A graceful shutdown that exceeds the bounded timeout falls back to terminating the exact PID returned by the control pipe.
- Both [source installers](./source-main-entry.md) also diagnose managed build prerequisites and reject unsupported Node.js versions before dependency installation; their build-time check follows the WebUI package engine range, not a new requirement on prebuilt backend or CLI execution.
- The Windows installer invokes the same stopped-state guard before dependency installation and uses the same background launcher, so later status, restart, and stop commands manage installer-started processes without installing over a running instance. It persists and exports its [selected data root](./source-main-entry.md#build-and-controls) before the guard and build, so control identity, upgrade inspection, logs and configuration/token lookup all follow that selection.

## Qualification boundary

Linux pipe-client tests and win-x64 cross-publish do not qualify Windows detachment, named-pipe ownership, loaded-native-file ordering or PowerShell installer execution. Those changed paths require actual independent Windows execution before a Windows runtime claim.

## Integration

- `npm run start:windows`, `restart:windows`, `status:windows`, and `stop:windows` are the shell-independent npm entry points.
- `scripts/start.ps1`, `restart.ps1`, `status.ps1`, and `stop.ps1` are direct PowerShell equivalents of the existing tmux helpers.
- `scripts/windowsService.test.js` covers data-root precedence, deterministic pipe naming, lifecycle log placement, guarded installer command routing, both source installers' Node version boundaries, and a real control-pipe request/response round trip.
