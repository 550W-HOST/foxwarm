# Unit: windows-service-scripts

Files: scripts/windowsService.js, scripts/windowsService.test.js, scripts/start.ps1, scripts/restart.ps1, scripts/stop.ps1, scripts/status.ps1
Secondary files: package.json, install-foxwarm.ps1, README.md

## Purpose

Provides native Windows build, background start, restart, status, and stop workflows without requiring Bash or tmux.

## Behavior

- Root builds remove obsolete generated files through Node filesystem APIs so the build command works in both POSIX shells and Windows `cmd.exe`. Full builds use checked-in lock files through `npm ci` and do not rewrite dependency manifests.
- Windows start refuses an existing instance before its lockfile install and full build. Restart builds against the installed dependency tree before changing the running service, so loaded native Windows DLLs are not removed by `npm ci`. PowerShell wrappers support `-SkipBuild` for an already-built checkout.
- The background launcher resolves the data root with the same environment, pointer-file, and checkout fallback precedence as application configuration.
- Lifecycle logs are appended under `<data-root>/state/logs/`.
- A data-root-specific local named pipe reports status and requests shutdown. Shutdown emits `SIGTERM` inside the running Node process so the application executes its existing graceful drain chain.
- A graceful shutdown that exceeds the bounded timeout falls back to terminating the exact PID returned by the control pipe.
- The Windows installer uses the same background launcher, so later status, restart, and stop commands manage installer-started processes.

## Integration

- `npm run start:windows`, `restart:windows`, `status:windows`, and `stop:windows` are the shell-independent npm entry points.
- `scripts/start.ps1`, `restart.ps1`, `status.ps1`, and `stop.ps1` are direct PowerShell equivalents of the existing tmux helpers.
- `scripts/windowsService.test.js` covers data-root precedence, deterministic pipe naming, lifecycle log placement, and a real control-pipe request/response round trip.
