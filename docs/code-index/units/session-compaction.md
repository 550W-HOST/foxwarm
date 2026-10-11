# Unit: Compaction planning, active history replacement, and Archive recall

Files: `dotnet/Foxwarm/ContextPreviewRenderer.Message.cs`, `dotnet/Foxwarm/ContextPreviewRenderer.cs`, `dotnet/Foxwarm/Sessions/Compaction/ArchiveContextReader.cs`, `dotnet/Foxwarm/Sessions/Compaction/ArchiveControlTools.cs`, `dotnet/Foxwarm/Sessions/Compaction/ArchiveRecallTool.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactCandidates.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPlan.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPlanRepairFile.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPrompt.Build.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPrompt.cs`, `dotnet/Foxwarm/Sessions/Compaction/ContextBlockExpansion.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.Commit.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.Plan.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.Prune.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.cs`

## Purpose

Plans context compaction, repairs bounded plan files, commits new immutable Archive blocks/messages with replacement active JSON history, and exposes exact capped Archive navigation/control tools.

## Stable methods and callers

- `SessionCompactor.StartManualAsync`, `AutoAfterTurnAsync`, `ApplyCompletedAsync`, `SafePointAsync`, `StopAsync`, and `DrainAsync` own one transient per-Session operation, phase publication, cancellation, ready-wake application, and shutdown draining.
- `SessionCompactor.PlanAsync`/`CommitAsync` and `SessionSaveLane.CommitCompactionAsync` stage the compact snapshot, recorded concrete memory identity, Archive rows, and active history; `PersistentSessionAuthorityStore.CommitCompactionAsync` writes Archive blocks/messages before active JSON and compensates only rows inserted before a failed rename.
- A successful planner run attaches a bounded `compaction.planner` diagnostic to the generated compact-completion message and the same Archive message row. The diagnostic contains only planner-appended rounds, tool names, invocation-local usage when reported, and newly appended planner messages; inherited Session history is not copied. Provider-free/display-only cleanup leaves the field absent.
- `SessionSaveLane.PublishCompactWakeAsync`, `RemoveCompactWakeAsync`, and `ReleaseStandaloneCompactAsync` order ready/standalone wake state. `QueueItem.CompactOwner` is in-process ownership only; JSON carries the source compact-commit marker, not a resumable background job.
- `ArchiveContextReader.Expand`, `ArchiveRecallTool`, `ArchiveControlTools`, `ContextBlockExpansion`, and `ContextPreviewRenderer` read committed local/effective lineage, exact ranges, block children, and source-labeled previews without mutating Archive rows.

Callers: `SessionOwner`/turn safe points, model prompt construction, `/compact` and stop controls, `SessionManager`, and WebUI context views.

## Safe-point and phase contract

A compaction operation captures admission mode and exact operation identity. Async planning publishes `ready` before wake insertion; applying a ready result occurs at a turn-host safe point before consuming the full visible ordinary batch, after complete tool pairing, before provider request construction, and during passive Stop finalization. Safe-point cancellation must not split a model/tool pair, inject fake input, cancel a declared wait, or replace a foreground draft with a background result. Standalone awaited Stop is a no-op for a held background planner; shutdown requests both cancellation paths and drains their independent lifetimes.

The compact commit refreshes memory using the recorded live concrete model identity. The active per-Session JSON/history remains the only source for the next live turn. Compaction may replace/prune active history and queue-related prompt state, but immutable Archive rows and branch lineage are not rewritten or used to reconstruct missing active authority. Pre-rename failure leaves prior authority and rolls back only newly staged rows; post-rename failure retains/publishes committed history/memory/version and is classified committed/too-late.

Plan submission uses the bounded `submit_compact_plan` shape with direct fields or operation-local `argsFilePath`; invalid direct input preserves raw provider argument text, while success/cancel/error/exhaustion paths clean up the transient repair directory. Repair guidance includes a bounded beginning/end preview of the current JSON artifact. Failed `apply_patch` repair calls use the shared `WorkspacePatch.Update` diagnostic: only the failing original hunk is returned, retaining anchor and edit prefixes within the 1,600-character bound; the pending file is not changed. The plan artifact is not Session/Archive history and is never resumed after restart.

## Recall and lineage contract

`ArchiveRecallTool` accepts only the supported selector subset (overview/help, frontier blocks, exact `B#N`/`block#N`, `msg:B#N`, and normalized `msg#A-B` ranges). `ArchiveContextReader` uses exact SQL ranges/child IDs and cumulative branch caps; it does not add hidden pages, whole-history prefixes, semantic archived-only target resolution, Vector search, or active-history reconstruction. Missing targets do not create Sessions, databases, or branch reservations. Context previews preserve distinct source/active budgets and include headers/source labels within the total budget.

Automatic response-only pruning commits only when the reconstructed live history estimate is strictly below 60% of the original estimate; the selected model window is not this decision's denominator. The save-lane commit rechecks that relative bound with concurrently admitted history before accepting the rewrite. Otherwise the existing layered planner runs.

Plan operations may carry an integer `frictionScore` from 0 through 100. Missing/invalid scores are omitted without rejecting an otherwise valid plan. Accepted scores flow through immutable Archive block records, active context-block metadata, candidate prompts, exact recall, expansion, and previews; existing unscored blocks remain unscored. This is diagnostic metadata, not a changed pruning or retention policy.

## Tests

`dotnet/Foxwarm.Tests/Sessions/CompactLifecycleTests.cs`; `CommittedArchiveBoundaryTests.cs`; `CommittedArchiveIdentityTests.cs`; `SelectedPromptTests.cs`; `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`.
