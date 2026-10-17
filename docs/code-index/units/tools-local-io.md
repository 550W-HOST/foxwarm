# Unit: Local file, exec, delivery, and workspace tools

Files: `dotnet/Foxwarm/Tools/ExecDuration.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.NodeCredentials.cs`, `dotnet/Foxwarm/Tools/ExecPetnames.cs`, `dotnet/Foxwarm/Tools/FileDeliveryDefinitions.cs`, `dotnet/Foxwarm/Tools/FileToolCore.Scanner.cs`, `dotnet/Foxwarm/Tools/FileToolCore.Write.cs`, `dotnet/Foxwarm/Tools/FileToolCore.cs`, `dotnet/Foxwarm/Tools/HandoffConfirmation.cs`, `dotnet/Foxwarm/Tools/LocalExecManager.Definitions.cs`, `dotnet/Foxwarm/Tools/LocalExecManager.cs`, `dotnet/Foxwarm/Tools/MainLocalToolDefinitions.cs`, `dotnet/Foxwarm/Tools/MainNativePaths.cs`, `dotnet/Foxwarm/Tools/PendingWriteRefs.cs`, `dotnet/Foxwarm/Tools/WorkspacePatch.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.Definitions.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.EditPatch.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.cs`

## Purpose

Implements bounded local file reads/writes/patches, native path/cwd rules, persistent and parallel exec, file delivery, and explicit handoff confirmation.

## Stable methods and callers

- `MainNativePaths` resolves data/workspace/tool roots and rejects traversal/cross-root paths; `FileToolCore` scans/reads/writes with byte/line/output limits and `PendingWriteRefs` tracks retryable write artifacts.
- `WorkspaceTools` exposes repository-aware list/read/write/edit/patch operations; `WorkspacePatch` parses/apply-checks bounded patches, accepts Unicode punctuation/space-equivalent context after strict matching, and reports only the original failing hunk (anchor and context/deletion/insertion prefixes) on a context mismatch, including EOF cases. `FormatContextErrorPath`, `FormatBoundedFailedHunk`, and `FormatContextMismatch` bound the diagnostic to 1,600 characters with head/tail retention for long hunks; no guessed candidate or file preview is included. The same update engine serves ordinary patches and operation-owned compact repair.
- `LocalExecManager` defines persistent/parallel process records, cwd/env/petname, timeout/kill/output lifecycle. `IsSupported` keeps local execution Linux-only; unsupported hosts retain an inactive manager for Session lifecycle, omit its local definitions, and return explicit unavailability if invoked internally. Connected Nodes still expose their own definitions. Process start comes from the launched process rather than artifact allocation; the wrapper captures millisecond finish time before sidecar publication. Foreground/completion output includes `Duration`, and background handoff includes `Elapsed`, using `ExecDuration.Format`. Detection-only recovered finishes and legacy fallback errors remain `unknown`; remote WS duration stays peer-provided. These are process clocks, not invocation `executionTiming`; `ExecPetnames` provides stable process labels.
- `FileDeliveryDefinitions` turns approved paths into authenticated delivery metadata; `HandoffConfirmation` requires ordered `handoffRecall` and final `handoffConfirmation` fields before enabled inter-agent handoffs.

Callers: `SessionToolExecutor`, `WebUIChannel.Files/Images`, Code services, and Node-compatible local tooling. All effects pass the unified authorization boundary first.

## Contract and side effects

Path/cwd checks are security and data-loss boundaries, not convenience validation. Reads/writes are bounded; patch/write retries retain artifact lifetime and do not assume a failed transport erased a successful filesystem change. Exec output is truncation-aware and process termination is explicit. Lifecycle cancellation ends a launched local exec's foreground wait with a process-shutdown receipt; explicit Stop/Run queued retain their own cause. Neither cancellation kills the independent process, reverses its effects, or replaces its actual finished result. The executor stays available until foreground turn owners settle. File delivery exposes deployment-relative/authenticated references, not local absolute paths.

## Tests

`dotnet/Foxwarm.Tests/Tools/MainExecCwdTests.cs`; `MainFileDeliveryTests.cs`; `FileRetryLifetimeTests.cs`; `ExecParallelTests.cs`; `MainNativePathTests.cs`; `ExecDurationTests.cs` (real foreground/background/recovered process clocks); `NodePrivateCredentialTests.cs`; `MainLocalToolsTests.cs`; `WorkspacePatchTests.cs`; `CompactLifecycleTests.cs` (paired failed-hunk feedback during repair).
