# Foxwarm Code Index

This repository-local index is a curated, public-safe map of Foxwarm. Source code and tests remain authoritative; the index supplies navigation, current contracts, and ownership boundaries.

## Scope

The active Main architecture is the .NET solution under `dotnet/`. The branch direction is to replace the TypeScript Main with .NET; this index does not claim that the TypeScript Main has already been removed or that every remote platform has been migrated. The existing WebUI, shared package, CLI Node, browser extension, Android Node, VS Code Web assets, website, and TypeScript compatibility code remain mapped where they are still real source boundaries.

## Governance

- Content is English and public-safe. Use source-relative paths only.
- Source and tests are the source of truth. Verify material claims against the fixed checkout before changing behavior.
- This is an active map, not a changelog. Remove stale migration history instead of preserving a second legacy index.
- Each unit has one primary `Files:` owner. Shared registration sites and tests belong under `Secondary files:` or a test note.
- A cross-module contract has one canonical thread owner; modules and units link to it rather than repeating the decision.

## Layout

- `overview.md` — project-wide architecture and starting points.
- `modules/` — cohesive responsibilities and child-unit navigation.
- `threads/` — end-to-end contracts crossing module boundaries.
- `units/` — small semantic file groups with stable symbols and callers.
- `scripts/audit_index.py` — link, ownership, and publication-safety checks.

Run `npm run quality:code-index` from the repository root after index changes.
