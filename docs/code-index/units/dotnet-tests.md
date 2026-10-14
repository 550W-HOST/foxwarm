# Unit: .NET test suite

Files: `dotnet/Foxwarm.Tests/`

## Purpose

The xUnit project is the executable contract map for the .NET host: channels/routes, images, memory, model wire/retries/journal, Session admission/turn/save/identity/catalog, Archive storage/lineage, timers/tasks, ToolScript, tools/authorization, and terminal/Code boundaries.

## Stable navigation

Use the test namespace/directory matching the owning module, then follow the production unit and thread. High-value persistence tests include `PersistentSessionTurnTests`, `SessionCatalogPublicationTests`, `PersistencePrimitiveTests`, `ArchiveLineageTests`, `SessionIdentityRecoveryTests`, and `CommittedArchiveBoundaryTests`; TaskStoreTests and SessionTurnTests cover Task anchors and terminal-loop behavior.

## Contract boundary

Tests establish source behavior for the checked revision, not release acceptance or root launcher migration. Documentation-only validation intentionally does not run this project or restart the runtime.

## Solution

`dotnet/Foxwarm.sln` includes `Foxwarm.Tests` and its linked parity/Responses fixtures.

The original-App/local-peer `packages/webui/test/experimentHostOctoberAlignment.e2e.mjs` covers the fixed Testing `4f9b9198` Main-local alignment: task scopes/trusted Activity, exec wait fallbacks, qualified native ToolScript calls, explicit JSON-opt-out Anthropic evidence/cache accounting, exact config installation, bounded patch errors, relative pruning, and scored compact/recall restart. It runs only disposable owned hosts and synthetic provider peers; it is not evidence for remote Node/Worker, inbound MCP, restricted access, or external channel runtime parity.

`dotnet/scripts/qualify-model-compaction.mjs` launches a disposable normal HTTP host and localhost Responses peer. It qualifies invalid masked config-save preservation, selected-leaf output/image settings with wire overrides, virtual selection, genuine skill retention versus material ordinary pruning, held-planner over-limit tool continuation through the exact owner commit, paired preserve/remove with immutable Archive reads, and a model-tool threshold override above the context limit followed by an over-context complete tool batch and normal request without a planner. The driver uses persisted access-token files and explicitly creates its fixture Agent. Companion xUnit `ModelDefaultsTests`, `CompactRetentionTests`, `CompactPruningTests`, and `CompactContinuationTests` cover precedence/validation, candidate accounting, persisted legacy skill readers, threshold-only planning, above-context threshold overrides on tool/queued continuations including equality, Stop/Run queued, ready-commit measurement consumption, and planner/authority-apply failure timing.

`AnthropicStreamingTests` exercises the actual Messages service with synthetic streams and controlled time: indexed UTF-8 accumulation, opaque progress exclusion, terminal/partial boundaries, callback/Stop disposal, cumulative usage and first-output/reasoning/ping deadlines. `packages/webui/test/experimentHostAnthropic.e2e.mjs` uses the original App and an owned host/local SSE peer to qualify live progress, message-stop completion without socket EOF, ordered real effects and invalid tool nonexecution, limit notices, JSON opt-out, journal/Archive, concrete replay/filtering, leaf image output and restart. Related JSON fixture peers explicitly opt out rather than relying on the former transport default.
