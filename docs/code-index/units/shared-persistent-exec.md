# Unit: shared-persistent-exec

Files: packages/shared/src/execBackend.ts, packages/shared/src/nativeExecBackend.ts, packages/shared/src/processOperations.ts, packages/shared/src/persistentExec.ts, packages/shared/src/persistentExec.test.ts

## Purpose

Owns one persistent-command manager for native and primitive-provider executions: public identity allocation, registry persistence, bounded foreground waiting, reconciliation, completion delivery and canonical output. Native process/artifact mechanics are extracted, not replaced with another provider manager.

## Key exports and function index

| Export or operation | Owner | Responsibility |
|---|---|---|
| `PersistentExecManager` | persistentExec | Registry, waits, reconciliation and formatting for both backends |
| `RunningExecEntry` | persistentExec | Exact owner, Node, command, cwd, output path and optional provider execution reference; native PID/status/cwd fields remain readable |
| `ExecStatus` | persistentExec | Actual exit code or unknown, timestamp/estimated hint, optional measured duration and error |
| `ExecOutputFiles` | persistentExec | Optional per-result read-only stat/read view supplied by Core; never retained in entries or backend resolution |
| `StartPersistentExecOptions` | persistentExec | Command and exact owner; optional requested public ID, provider ID and final prelaunch fence |
| `ExecBackend` | execBackend | Core-owned start/poll, target log filesystem and known-cwd bridge; not the external adapter protocol |
| `ExecStarted`, `ExecSnapshot`, `ProviderExecReference` | execBackend | Start receipt, running/finished/lost observations and private persisted provider/ref identity |
| `NativeExecBackend.start()` | nativeExecBackend | Native cwd validation, Agent env, date-co-located scripts/artifacts, detached launch and path discovery |
| `NativeExecBackend.poll()` | nativeExecBackend | Native status parsing, PID observation and missing-status fallback |
| `NativeExecBackend.readFinishedWorkingDirectory()` / `readLiveWorkingDirectory()` / `inspectSnapshot()` | nativeExecBackend | Native cwd and process facts |
| `ProcessOperations`, `nativeProcessOperations` | processOperations | Target-local launch, runtime/platform identity, liveness, live cwd and process snapshots |
| `startPersistentExec()` | manager | Reserve public ID, call the chosen backend once and persist its receipt |
| `waitForExecCompletion()` | manager | Foreground timeout/Stop waiting without command termination |
| `markExecForBackgroundNotification()` / `finalizeForegroundExec()` | manager | Serialized lifecycle mutations in the existing registry |
| `reconcileNow()` / `shutdown()` | manager | Await one pass or drain timer/registry work without deleting or killing active commands |
| `getRunningExec()` / `hasRunningExecs()` / `listRunningExecs()` | manager | Owner-local tracking inspection used by existing wait/result paths |
| `getResolvedExecCwd()` | manager | Known final cwd or the actual start cwd; model synchronization separately avoids guessing unknown final cwd |
| `buildForegroundExecResult()` / `buildBackgroundTimeoutResult()` / `buildCompletionMessage()` | manager | One shared canonical display formatter |
| `buildProgrammaticExecResult()` | manager | Retained raw log snapshot, never parsed display output, within the inclusive 1 MiB budget |
| `resolveExecTimeoutSeconds()` / timeout constants | persistentExec | Default 15 seconds, minimum 1, maximum foreground wait 60, separate clamp warning |
| `formatExecDuration()` | persistentExec | Human-readable valid measured intervals; invalid/negative/estimated intervals remain unknown |
| `truncateProcessCmdline()` / `formatProcessTreeSnapshot()` | persistentExec | Bounded native process-tree display |
| `BACKGROUND_COMPLETION_EVENT_RETENTION_MS` | persistentExec | Strictly older than 24 hours expires tracking without deleting artifacts or stopping commands |
| Petname generation/constants and `isSupportedPersistentExecId()` | persistentExec | Public IDs plus historical persisted-ID acceptance |

## Native mechanics and compatibility

- Bash/PowerShell wrappers capture merged output, final cwd and actual exit status. Paths are published through the existing temporary paths file. New native starts prepare the real Agent tmp directory, validate target-local cwd and record time immediately before launch. External namespaces omit Agent mapping and strip inherited reserved `fw_agentdir`/`fw_tmp` values. Windows strips case variants; POSIX preserves unrelated uppercase names.
- `NativeExecBackend` owns those scripts/artifacts and delegates low-level process facts to `ProcessOperations`. `PersistentExecManager` owns public identity, durable registry mutation, wait/notification lifetime and result formatting. Native status polling preserves its existing cadence and status-before-Stop precedence; native status-read errors are not reclassified as successful exits.
- Missing native status falls back only after the managed PID is no longer running and the existing grace period has elapsed. The fallback has unknown exit code, a detection timestamp and the existing missing-status error; its duration is unknown. Missing retention-pruned status parents are recreated before atomic fallback publication.
- Persisted native records without `backend` remain native and are not rewritten into provider records. Native PID/status/cwd fields, historical `exec_...` IDs, CLI completion capabilities, external-owner records and normal authenticated CLI protocol versions are unchanged.

## Shared tracking and provider observations

- The existing registry contains both backends. Provider records add only `backend:{providerId,ref}` and use the same owner, Node, command, cwd, output path, start time and notification state. No second registry, formatter, lease, outbox or provider-specific exec manager exists.
- Core's configured resolver binds a persisted provider ID and Node ID directly to that provider. It does not choose another provider or native backend when configuration is missing. The external adapter receives only public primitive DTOs; the internal backend bridge does not serialize Session objects, callback functions or cancellation signals.
- Start is invoked once. An uncertain receipt does not cause command replay. Launch and registry persistence retain the existing crash uncertainty window; no transaction or exactly-once claim is introduced. A final synchronous prelaunch fence runs before effect. Ordinary Stop is not passed to the provider launcher; independent hard owner-loss/deadline cancellation may terminate its RPC, leaving an explicitly unknown start outcome.
- Provider polling has one shared in-flight query per execution across foreground and background observers. Foreground waits race query progress against their own timeout/Stop wakeup. Reconciliation observes entries concurrently so one slow provider does not delay another entry's completion delivery. External metadata polling is capped separately by the executable transport at five seconds.
- A transient provider query error retains tracking. Explicit lost state becomes an unknown exit with a loss reason, not exit zero. Known provider cwd is retained from observations, not reconstructed from host process state. Unknown PIDs/process trees are omitted; native trees remain available.
- Completion dispatch still targets the recorded exact owner. A failed delivery remains retryable; removal follows acknowledged delivery through the existing serialized mutation/persistence chain. Expiration is checked before status queries or notification. Startup marks recovered records for notification before reconciliation and expiration.
- Concurrent initialization shares one load/reconcile promise. Start, mark and removal share the existing registry mutation lane. Public ID reservations are process-local and released on all start terminal paths. Registry-idle callbacks run only after an empty snapshot has been persisted.

## Output and cwd

- Result builders accept an optional per-result `ExecOutputFiles` view; without it, native/default observation is unchanged. Core uses this only for bounded/cancellable primitive-provider foreground output. An expired or stopped observation reports unavailable/truncated capture while retaining actual exit state, tracking and the independently recoverable backend.
- Logs are read through the selected backend's `FileOperations`; provider paths remain target-native and are not copied into a second Main log store. Output loss is distinct from a known finished exit: display reports unavailable output and programmatic results omit full content with `truncated:true` rather than inventing empty capture data.
- Stat-time snapshots at or below 1 MiB use bounded reads of that snapshot. Larger logs read only 5,000-byte head/tail samples. Byte offsets and sizes are exact; Unicode/binary classification and display conversions use the shared bounded-text implementation. Programmatic content above 1 MiB is omitted rather than sampled as if complete.
- Boundary whitespace is preserved, including whitespace-only output. Only a zero-byte capture gets a no-output placeholder. Metadata begins after the existing trailing LF or one separator LF; missing captured trailing LF is stated explicitly. Oversized logs report byte size, not an invented original line count.
- Foreground and completion duration uses real timestamps or a supplied measured duration, not wait budget or dispatch time. Legacy missing or synthetic timestamps retain notification timestamps but display unknown duration. Timeout results show current elapsed time instead.
- Known cwd crosses the Core adapter as private result metadata. Exact Session-owner synchronization and deferred replay enforce that the Session still selects that Node. Existing native cwd behavior and Node-selection entry points remain unchanged; provider cwd whitespace remains target data.

## Design decisions

### D-persistent-exec-process-operations

`ProcessOperations` remains the small native syscall seam, not a remote-environment API. `NativeExecBackend` owns native shell/artifact/cwd mechanics. A separate Core-owned `ExecBackend` bridge lets the same manager consume generic external start/poll and target file primitives without moving registry, wait, formatting or delivery responsibility into the external provider.

### D-persistent-exec-completion-event-retention

Measure tracking age from persisted `startedAt`. At ages at or below 24 hours, preserve normal observation and acknowledged delivery. At strictly greater ages, remove tracking before queries or delivery. Do not kill the command or delete its output/status/scripts. Recovery marks entries for notification, then applies the same expiration path.

### D-persistent-exec-date-co-located-artifacts

Every native run's log, status, recorded cwd, wrapper script, Windows user-command script and transient paths file belong to its start-date directory. The paths file is normally removed after consumption. The one-time historical migration remains owned by [D-legacy-undated-exec-artifact-migration](./src-migrations.md#d-legacy-undated-exec-artifact-migration). Provider artifacts belong to the adapter's target namespace and retention policy.

### D-persistent-exec-bounded-log-excerpts

Retain the raw captured log, using the shared bounded sampling/classification contract in [D-bounded-file-read-excerpts](./shared-node-tools.md#d-bounded-file-read-excerpts). Display does not reconstruct output before an agent's shell filtering. Notifications abbreviate command previews with bounded head/tail text. Programmatic data uses actual retained bytes under [D-dispatch-programmatic-tool-data](../threads/tool-dispatch-node-execution.md#d-dispatch-programmatic-tool-data).

### D-persistent-exec-background-timeout-footer-tree

Partial output precedes a metadata footer beginning with `---`. Timeout/Stop identifies the real outstanding exec and same-Node log and states that completion remains outstanding. Native runtimes include best-effort managed-shell trees: at most 40 processes and 100 characters per command line. Inspection failure renders unavailable process information without changing command lifetime. Providers without native facts omit them, rather than exposing Main process information for a remote command.

### D-persistent-exec-preserve-boundary-whitespace

Preserve captured output whitespace exactly in foreground and timeout previews. The added metadata separator is not command output. Empty output alone gets a placeholder; no-trailing-LF notices distinguish final and partial capture. Main and CLI share the same implementation.

## Integration and tests

Main's `createExecRuntime` supplies persistence and exact-owner completion dispatch. TypeScript CLI tools continue using their existing native managers and external-owner namespace contracts. The [.NET CLI adapter](./dotnet-cli-node.md#persistent-session-exec) preserves Session and external native namespaces and their distinct acknowledged lifecycles without importing Main’s different manager or Provider registry. `src/nodes/providerExecBackend.ts` is the Core-only bridge for optional external process primitives, not an adapter SDK import.

`persistentExec.test.ts` covers native launch, cwd, output, Stop, registry/recovery, expiration, identity allocation, mutation ordering and notifications. Process-separated provider uncertainty, loss, query bounds, restart and raw-output tests belong to [src-node-providers](./src-node-providers.md). Foreground cancellation semantics remain canonical in [Stop and Run queued](../threads/message-processing-pipeline.md#d-pipeline-control-commands).
