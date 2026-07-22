# Unit: src-exec-manager

Files: src/execManager.ts, src/tools/execToolMessages.test.ts

## Purpose

Provides a thin application-level wrapper around `PersistentExecManager` (from the shared package) to manage long-running shell executions, track their lifecycle, and dispatch completion notifications to sessions. The test file validates timeout handling, output truncation formatting, cwd resolution, and log file naming conventions.

## Key Exports

- `initializeExecManager(options?)` — bootstraps the persistent exec manager
- `startPersistentExec(options)` — launches a new tracked shell execution
- `waitForExecCompletion(execId, timeoutMs)` — blocks until exec finishes or times out
- `markExecForBackgroundNotification(execId)` — flags an exec to notify on completion
- `finalizeForegroundExec(execId)` — cleans up a foreground exec entry
- `buildForegroundExecResult(entry, status, warning?)` — formats completed exec output and optional footer warning for display
- `buildBackgroundTimeoutResult(entry, timeoutSeconds, warning?)` — formats timeout message and optional metadata warning for backgrounded exec
- `readFinishedExecWorkingDirectory(entry)` — reads final cwd of a completed exec
- `readLiveExecWorkingDirectory(entry)` — reads current cwd of a running exec
- `listRunningExecs()` — returns all currently tracked exec entries
- Re-exports: `DEFAULT_EXEC_TIMEOUT_SECONDS`, `MIN_EXEC_TIMEOUT_SECONDS`, `MAX_EXEC_TIMEOUT_SECONDS`, `ExecStatus`, `RunningExecEntry`

## Function Index

| Function | Lines (approx) | Description |
|----------|---------------|-------------|
| `completionDispatcher` (default) | ~46–51 | Default completion callback that queues a session system event |
| `initializeExecManager(options?)` | ~53–58 | Sets custom dispatcher and initializes the underlying manager |
| `startPersistentExec(options)` | ~60–62 | Delegates exec start to PersistentExecManager with default nodeId |
| `waitForExecCompletion(execId, timeoutMs)` | ~64–66 | Delegates wait-for-completion to the manager |
| `markExecForBackgroundNotification(execId)` | ~68–70 | Delegates background notification marking |
| `finalizeForegroundExec(execId)` | ~72–74 | Delegates foreground exec cleanup |
| `buildForegroundExecResult(entry, status, warning?)` | ~66 | Delegates foreground result formatting, including the `--- / Exit code` footer and optional timeout-clamp warning |
| `buildBackgroundTimeoutResult(entry, timeoutSeconds, warning?)` | ~70 | Delegates background timeout result formatting and optional timeout-clamp warning |
| `readFinishedExecWorkingDirectory(entry)` | ~84–86 | Delegates reading finished exec cwd |
| `readLiveExecWorkingDirectory(entry)` | ~88–90 | Delegates reading live exec cwd |
| `listRunningExecs()` | ~92–94 | Returns list of running execs from manager |
| `buildExecEntry(logPath, overrides)` (test) | ~10–26 | Test helper to construct a mock RunningExecEntry |

## Dependencies

- `./config` — `STATE_DIR`, `getAgentDir`
- `./common` — `logger`
- `./sessionManager` — `queueSessionSystemEvent`
- `../packages/shared/dist/persistentExec` — `PersistentExecManager` and related types/constants
- `./tools` (test only) — `definitions`, `exec`, `read`

## Behavior

- Instantiates a singleton `PersistentExecManager` configured with project-specific paths (agent directories, temp dirs, registry file at `STATE_DIR/running-exec.json`).
- The default completion dispatcher sends a system event to the session associated with the exec entry; this can be overridden at initialization.
- All public functions are thin async delegates to the underlying manager instance, adding only the default `nodeId: 'master'`.
- The exec handler uses shared timeout resolution: finite requests above 60 seconds wait for only 60 seconds, while forwarding the requested/effective warning into either foreground or background-switch result formatting.
- The registry file persists running exec state to disk for crash recovery.

## Integration

- Used by the `exec` tool handler (in `./tools`) to run user-requested shell commands with timeout and background semantics.
- Connects to `sessionManager` to push background completion notifications back into active agent sessions.
- Relies on `config` for workspace/agent directory resolution and state directory paths.
- The shared `PersistentExecManager` handles process spawning, log file management, line-aware output truncation, foreground exit-code footers, and cwd tracking.