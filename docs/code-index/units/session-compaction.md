# Unit: Compaction planning, active history replacement, and Archive recall

Files: `dotnet/Foxwarm/ContextPreviewRenderer.Message.cs`, `dotnet/Foxwarm/ContextPreviewRenderer.cs`, `dotnet/Foxwarm/Sessions/Compaction/ArchiveContextReader.cs`, `dotnet/Foxwarm/Sessions/Compaction/ArchiveControlTools.cs`, `dotnet/Foxwarm/Sessions/Compaction/ArchiveRecallTool.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactCandidates.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPlan.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPlanRepairFile.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPrompt.Build.cs`, `dotnet/Foxwarm/Sessions/Compaction/CompactPrompt.cs`, `dotnet/Foxwarm/Sessions/Compaction/ContextBlockExpansion.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.Commit.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.Plan.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.Prune.cs`, `dotnet/Foxwarm/Sessions/Compaction/SessionCompactor.cs`

## Purpose

Plans context compaction, repairs bounded plan files, commits new immutable Archive blocks/messages together with a replacement active JSON history, and exposes exact Archive navigation/control tools.

## Stable methods and callers

- `SessionCompactor.StartManualAsync`, `PlanAsync`, and plan/repair helpers select candidates from the current owner snapshot and produce a bounded `CompactPlan`.
- `SessionCompactor.CommitAsync` and `SessionSaveLane.CommitCompactionAsync` stage the new history plus Archive rows; `PersistentSessionAuthorityStore.CommitCompactionAsync` writes blocks/messages before active JSON and rolls back only inserted rows on pre-rename failure.
- `ArchiveContextReader.Expand`, `ArchiveRecallTool`, and `ArchiveControlTools` read committed local/effective lineage and expose bounded exact navigation without mutating Archive rows.
- `ContextBlockExpansion` and `ContextPreviewRenderer` render committed block references into model-visible context while retaining source ranges and identity.

Callers: `SessionOwner`, model prompt construction, `/compact`/stop controls, `SessionManager`, and WebUI context views.

## Contract and side effects

The active per-Session JSON/history remains the only source for the next live turn. Compaction can replace/prune active history and queue-related prompt state, but immutable Archive rows and branch lineage are not rewritten or used to reconstruct a missing active authority file. A ready compact commit and its wake marker are ordered through the save lane; cancellation before publication leaves the prior active history and only compensates rows inserted by the cancelled attempt.

Plan repair reads/writes a bounded raw file and validates candidate ranges before admission. Archive recall is read-only and applies lineage fork caps, so late parent/child rows cannot leak into a descendant view.

## Tests

`dotnet/Foxwarm.Tests/Sessions/CompactLifecycleTests.cs`; `CommittedArchiveBoundaryTests.cs`; `CommittedArchiveIdentityTests.cs`; `SelectedPromptTests.cs`; `dotnet/Foxwarm.Tests/Storage/ArchiveLineageTests.cs`.
