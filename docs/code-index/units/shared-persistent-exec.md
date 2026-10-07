# Unit: Shared persistent exec lifecycle

Files: `packages/shared/src/persistentExec.ts`, `packages/shared/src/persistentExec.test.ts`, `packages/shared/src/processOperations.ts`

## Purpose

Tracks background command processes across reconciliation/restart, preserves artifact and notification lifecycle, and formats foreground/timeout output while delegating only target-local launch/liveness/live-cwd primitives to `processOperations`.

## Stable symbols and callers

- `PersistentExecManager.start`, `waitForExecPaths`, `waitForCompletion`, `reconcileRunningExecs`, `reconcileNow`, `shutdown`, `loadRegistry`, `saveRegistry`, `commitRegistryMutation`, `listRunningExecs`, `getRunningExec`, and `getResolvedExecCwd` own lifecycle/registry/reconciliation.
- `buildManagedExecScript`, `buildStatusWriterInvocationPosix`, and `buildResolvedExecPaths` create wrapper/artifact paths; `readExecStatus`, `readExecCwd`, `readFinishedExecWorkingDirectory`, and `readLiveExecWorkingDirectory` consume status/cwd state.
- `buildForegroundExecResult`, `buildBackgroundTimeoutResult`, `buildCompletionMessage`, `readDisplayOutput`, `readOversizedLogSamples`, `analyzeTextLogSample`, and `renderTextLogSample` own result/preview formatting.
- `nativeProcessOperations.launch`, `inspectSnapshot`, `isRunning`, and `readWorkingDirectory` are the injected target-local process boundary; they do not own registry, retention, wrapper scripts, or notifications.

Callers: CLI Node/local exec, Main local tools, remote-node compatibility adapters, and ToolScript’s unified `call_tool` path.

## Retention and artifact contracts

A persisted `RunningExecEntry` is measured from `startedAt`. At ages at or below 24 hours, reconciliation and acknowledged completion delivery continue normally. At strictly older ages, tracking-only expiry removes registry/notification tracking but does not kill the underlying process or delete log/status/cwd/wrapper artifacts. Restart recovery marks recovered records for background notification before applying this TTL, so stale recovered entries cannot emit a late completion event.

Every artifact for one run is written under its start-date directory: log, status, recorded cwd, generated wrapper/user-command script, and transient paths coordination file. The coordination file is normally consumed and removed after path discovery. The persisted entry retains the exact generated script path and owner/capability identity; registry mutation and idle-cleanup callbacks run through one serialized mutation chain.

## Output and boundary behavior

Foreground and timeout partial output preserve command-output boundary whitespace exactly: leading blank lines/indentation, trailing spaces/blank lines, and whitespace-only output survive. Only a zero-byte output is absent. Oversized logs use bounded head/tail sampling and UTF-8-aware suspicious-byte rendering; shared line-aware truncation adds omission placeholders without rewriting the retained full log. Timeout footers describe output captured “so far” and do not imply final output.

Completion delivery is acknowledged and removed only through the existing lifecycle path. Unknown-exit fallback synthesizes status without falsely classifying a launcher failure as a definite pre-effect failure. Persistent exec is tracking/lifecycle state, not an authorization boundary or process-kill guarantee.

## Tests

`packages/shared/src/persistentExec.test.ts`; process-operation, output-truncation, CLI exec, and remote compatibility tests.
