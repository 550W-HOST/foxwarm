# Unit: Local file, exec, delivery, and workspace tools

Files: `dotnet/Foxwarm/Tools/ExecPetnames.cs`, `dotnet/Foxwarm/Tools/FileDeliveryDefinitions.cs`, `dotnet/Foxwarm/Tools/FileToolCore.Scanner.cs`, `dotnet/Foxwarm/Tools/FileToolCore.Write.cs`, `dotnet/Foxwarm/Tools/FileToolCore.cs`, `dotnet/Foxwarm/Tools/HandoffConfirmation.cs`, `dotnet/Foxwarm/Tools/LocalExecManager.Definitions.cs`, `dotnet/Foxwarm/Tools/LocalExecManager.cs`, `dotnet/Foxwarm/Tools/MainLocalToolDefinitions.cs`, `dotnet/Foxwarm/Tools/MainNativePaths.cs`, `dotnet/Foxwarm/Tools/PendingWriteRefs.cs`, `dotnet/Foxwarm/Tools/WorkspacePatch.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.Definitions.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.EditPatch.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.cs`

## Purpose

Implements bounded local file reads/writes/patches, native path/cwd rules, persistent and parallel exec, file delivery, and explicit handoff confirmation.

## Stable methods and callers

- `MainNativePaths` resolves data/workspace/tool roots and rejects traversal/cross-root paths; `FileToolCore` scans/reads/writes with byte/line/output limits and `PendingWriteRefs` tracks retryable write artifacts.
- `WorkspaceTools` exposes repository-aware list/read/write/edit/patch operations; `WorkspacePatch` parses/apply-checks bounded patches, accepts Unicode punctuation/space-equivalent context after strict matching, and reports bounded candidate/mismatch diagnostics including EOF cases.
- `LocalExecManager` defines persistent/parallel process records, cwd/env/petname, timeout/kill/output lifecycle; `ExecPetnames` provides stable process labels.
- `FileDeliveryDefinitions` turns approved paths into authenticated delivery metadata; `HandoffConfirmation` requires ordered `handoffRecall` and final `handoffConfirmation` fields before enabled inter-agent handoffs.

Callers: `SessionToolExecutor`, `WebUIChannel.Files/Images`, Code services, and Node-compatible local tooling. All effects pass the unified authorization boundary first.

## Contract and side effects

Path/cwd checks are security and data-loss boundaries, not convenience validation. Reads/writes are bounded; patch/write retries retain artifact lifetime and do not assume a failed transport erased a successful filesystem change. Exec output is truncation-aware and process termination is explicit. File delivery exposes deployment-relative/authenticated references, not local absolute paths.

## Tests

`dotnet/Foxwarm.Tests/Tools/MainExecCwdTests.cs`; `MainFileDeliveryTests.cs`; `FileRetryLifetimeTests.cs`; `ExecParallelTests.cs`; `MainNativePathTests.cs`; `MainLocalToolsTests.cs`.
