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

The original-App/local-peer `packages/webui/test/experimentHostOctoberAlignment.e2e.mjs` covers the fixed Testing `4f9b9198` Main-local alignment: task scopes/trusted Activity, exec wait fallbacks, qualified native ToolScript calls, nonstreaming Anthropic evidence/cache accounting, exact config installation, bounded patch errors, relative pruning, and scored compact/recall restart. It runs only disposable owned hosts and synthetic provider peers; it is not evidence for remote Node/Worker, inbound MCP, restricted access, or external channel runtime parity.
