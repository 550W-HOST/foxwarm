# Unit: src-exec-manager

Files: src/execManager.ts, src/tools/execToolMessages.test.ts

## Purpose

Provides a thin application-level wrapper around `PersistentExecManager` (from the shared package) to manage long-running shell executions, track their lifecycle, and dispatch completion notifications to sessions. The test file validates timeout handling, output truncation formatting, cwd resolution, and log file naming conventions.

## Key Exports

- `createExecRuntime(options)` — constructs one isolated application exec runtime around exactly one `PersistentExecManager`
- `ExecRuntime` / `ExecRuntimeOptions` — closed runtime lifecycle and configurable registry/default-cwd/temp-root providers, including process operations, entry-aware liveness/cwd, one-shot reconcile, and shutdown
- `getDefaultExecRuntime()` — read-only access to the factory-built process-default runtime; callers cannot replace or stop it
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
| `createExecRuntime(options)` | factory | Owns one manager, mutable late-bound dispatcher, node default, persistence paths, formatting/cwd delegates, and list without exposing the manager |
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
- `../packages/shared/dist/processOperations` — native and injectable process primitives passed to the shared manager
- `./tools` (test only) — `definitions`, `exec`, `read`

## Behavior

- The process-default runtime is itself created by `createExecRuntime`, configured with the unchanged project paths (agent directories, temp dirs, registry file at `STATE_DIR/running-exec.json`) and `master` node default. Every existing exported wrapper delegates to that real factory-built default.
- Each factory call owns independent manager, dispatcher closure, registry, temp-root providers, process backend, and initialization/reconcile state. The native backend is default. `reconcileNow()` performs an awaited pass and `shutdown()` idempotently clears the timer and drains reconcile/registry work without deleting persisted active entries, allowing resident provider generations to retire without timer growth and Core to close all runtimes orderly.
- The default completion dispatcher sends a system event to the session associated with the exec entry; this can be overridden at initialization.
- All public functions are thin async delegates to the underlying manager instance, adding only the default `nodeId: 'master'`.
- The exec handler uses shared timeout resolution: finite requests above 60 seconds wait for only 60 seconds, while forwarding the requested/effective warning into either foreground or background-switch result formatting. Oversized persistent logs use the shared bounded excerpt contract rather than full reads; see [D-persistent-exec-bounded-log-excerpts](./shared-persistent-exec.md#d-persistent-exec-bounded-log-excerpts). Background-switch footer and live-tree behavior is canonical in [D-persistent-exec-background-timeout-footer-tree](./shared-persistent-exec.md#d-persistent-exec-background-timeout-footer-tree).
- The registry file persists running exec state to disk for crash recovery.
- Normal `CurrentSessionEffects` carry the process-default runtime into internal ToolContext, while detached owners may supply another process-local factory runtime. One exec call chooses one runtime for start/wait/cwd/format/mark/finalize and never mixes instances. Legacy/direct handler calls retain the existing wrapper-built default fallback.
- Exact trusted owners use their persistence hook for the unconditional pre-exec save and normalized cwd updates; legacy/no-hook callers retain SessionManager/SessionRuntime. Parallel direct-exec segments replay cwd against that same passed owner in model order before later barriers, so the last model call owns cwd without a global lookup.

## Integration

- Used by the `exec` tool handler (in `./tools`) to run user-requested shell commands with timeout and background semantics.
- Connects to `sessionManager` to push background completion notifications back into active agent sessions.
- Relies on `config` for workspace/agent directory resolution and state directory paths.
- The shared `PersistentExecManager` handles process spawning, log file management, line-aware output truncation, foreground exit-code footers, and cwd tracking.