# Unit: shared-persistent-exec

Files: packages/shared/src/persistentExec.ts

## Purpose

Manages persistent (background) command execution with lifecycle tracking, log capture, and completion notifications. Spawns shell processes that write their own status/log files, polls for completion, and formats results for agent consumption.

## Key Exports

- `PersistentExecManager` — Main class orchestrating process spawning, tracking, reconciliation, and result formatting
- `RunningExecEntry` — Interface describing a tracked running process
- `ExecStatus` — Interface for process exit status
- `StartPersistentExecOptions` — Options for starting a new execution
- `ExecCompletionDispatcher` — Callback type for delivering completion notifications
- `PersistentExecManagerOptions` — Configuration for the manager
- `DEFAULT_EXEC_TIMEOUT_SECONDS`, `MIN_EXEC_TIMEOUT_SECONDS`, `MAX_EXEC_TIMEOUT_SECONDS` — Timeout constants
- `resolveExecTimeoutSeconds(timeoutValue)` / `ResolvedExecTimeout` — validates timeout input, clamps finite values above 60 seconds, and returns requested/effective values with an optional warning

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `resolveExecTimeoutSeconds(timeoutValue)` | ~20 | Preserves default/valid timeouts, rejects invalid or below-minimum values, and clamps finite oversized values with a warning |
| `sleep(ms)` | ~82 | Promise-based delay helper |
| `escapeInlineCode(text)` | ~86 | Escapes backticks for inline code display |
| `summarizeCommandForNotification(text, maxLength)` | ~90 | Truncates command text for notification previews |
| `formatExecTimeoutSeconds(seconds)` | ~96 | Formats timeout value as string |
| `buildBackgroundTimeoutShortNotice(timeoutSeconds)` | ~100 | Short timeout notice string |
| `buildBackgroundTimeoutFullNotice(timeoutSeconds)` | ~104 | Full timeout notice with instructions to stop polling |
| `isPidRunning(pid)` | ~109 | Checks if a process is alive via signal 0 |
| `buildStatusWriterInvocationPosix()` | ~117 | Generates Node one-liner to write status JSON on POSIX |
| `buildManagedExecScript(command)` | ~121 | Builds platform-specific wrapper script (bash/PowerShell) for managed execution |
| `buildResolvedExecPaths(execDir, timeToken, pid, collisionIndex)` | ~195 | Constructs log/status/cwd file paths from components |
| `PersistentExecManager.start(options)` | ~240 | Spawns a managed child process and registers it |
| `PersistentExecManager.waitForExecPaths(pathsPath)` | ~310 | Polls for the paths JSON file written by the child |
| `PersistentExecManager.waitForCompletion(entry, timeoutSeconds)` | ~335 | Polls status file until process finishes or times out |
| `PersistentExecManager.buildForegroundExecResult(entry, status)` | ~580 | Formats completed foreground output with line-aware excerpting and an exit-code footer |
| `PersistentExecManager.buildBackgroundTimeoutResult(entry, timeoutSeconds)` | ~390 | Formats partial output when process exceeds timeout |
| `PersistentExecManager.buildCompletionMessage(entry, status)` | ~400 | Builds notification message for background completion |
| `PersistentExecManager.readFinishedExecWorkingDirectory(entry)` | ~410 | Reads final cwd from file after process exits |
| `PersistentExecManager.readLiveExecWorkingDirectory(entry)` | ~414 | Reads cwd of a live process via /proc or lsof |
| `PersistentExecManager.listRunningExecs()` | ~418 | Returns all tracked running entries |
| `PersistentExecManager.reconcileRunningExecs()` | ~422 | Checks background processes for completion and dispatches notifications |
| `PersistentExecManager.readPartialLog(logPath)` | ~355 | Reads last N bytes of a log file for preview |
| `PersistentExecManager.readDisplayOutput(logPath)` | ~510 | Reads log output for inline display and delegates over-budget excerpts to shared line-aware truncation |
| `PersistentExecManager.readExecStatus(statusPath)` | ~325 | Parses the JSON status file |
| `PersistentExecManager.ensureFallbackStatus(entry)` | ~330 | Returns status or synthesizes one if process died without writing status |
| `PersistentExecManager.readExecCwd(cwdPath)` | ~345 | Reads the cwd text file |
| `PersistentExecManager.readProcessCwd(pid)` | ~350 | Reads live process cwd from OS |
| `PersistentExecManager.addRunningExec(entry)` | ~295 | Persists entry to registry and in-memory map |
| `PersistentExecManager.removeRunningExec(id)` | ~300 | Removes entry from registry and map |
| `PersistentExecManager.loadRegistry()` | ~280 | Loads running exec registry from disk on startup |
| `PersistentExecManager.saveRegistry()` | ~290 | Persists current running execs map to disk |
| `PersistentExecManager.startReconcileLoop()` | ~270 | Starts periodic reconciliation interval |
| `PersistentExecManager.dispose()` | ~275 | Stops reconcile loop and cleans up |

## Dependencies

- `./execCwd` — `resolveValidatedExecCwd`, `ExecCwdSource` for working directory resolution and validation
- `./tokenCount` — `estimateTokenCount` for output size estimation

## Behavior

- Spawns commands inside a generated wrapper script (bash on POSIX, PowerShell on Windows) that handles log redirection, exit code capture, and cwd recording via atomic file writes.
- The child process writes a paths JSON file so the parent can discover log/status/cwd paths without race conditions.
- Tracks running processes in an in-memory map backed by a JSON registry file on disk, enabling recovery after restarts.
- A periodic reconcile loop polls status files of background processes and dispatches completion notifications via the configured `completionDispatcher`.
- Uses `isPidRunning` as a fallback to detect processes that died without writing a status file, synthesizing an error status in that case.
- Output formatting handles truncation with shared line-aware per-line and whole-line omission placeholders, plus token estimation for inline display decisions.
- Foreground exec completions always append a footer beginning with `---` and `Exit code: ...`; truncated outputs add the full log path plus Foxwarm placeholder/original size notes. An oversized-timeout warning is passed separately into foreground/background-switch formatting, so it remains in final metadata even when command output is truncated. Later background completion notifications do not repeat the already-delivered warning.

## Integration

- Used by agent execution infrastructure to run shell commands with timeout/background semantics.
- Relies on `resolveValidatedExecCwd` to safely resolve and validate working directories from multiple sources (session, agent default).
- The `completionDispatcher` callback connects to the agent messaging layer to notify users/agents when background commands finish.
- Registry persistence allows the system to recover awareness of still-running processes after a server restart.