# Foxwarm Code Index

This repository-local index is a curated, public-safe map of Foxwarm. Source code and tests remain authoritative; the index supplies navigation, current contracts, and ownership boundaries.

## Scope

The active Main architecture is the .NET solution under `dotnet/`. The branch direction is to replace the TypeScript Main with .NET; this index does not claim that the TypeScript Main has already been removed or that every remote platform has been migrated. The existing WebUI, shared package, CLI Node, browser extension, Android Node, VS Code Web assets, website, and TypeScript compatibility code remain mapped where they are still real source boundaries.

## Governance

- Content is English and public-safe. Use source-relative paths only; never record credentials, private repository names, personal filesystem paths, deployment addresses, private hostnames, private runbooks, or live-environment procedures.
- Source and tests are the source of truth. Verify material claims against the fixed checkout before changing behavior.
- This is an active map, not a changelog. Remove stale migration history instead of preserving a second legacy index.
- Each unit has one primary `Files:` owner. Shared registration sites and tests belong under `Secondary files:` or a test note; a source file must not have two primary owners.
- A cross-module contract has one canonical thread owner; modules and units link to it rather than repeating the decision.

## Layout

- `overview.md` — project-wide architecture and starting points.
- `modules/` — cohesive responsibilities and child-unit navigation.
- `threads/` — end-to-end contracts crossing module boundaries.
- `units/` — small semantic file groups with stable symbols, callers, behavior, and tests.
- `scripts/audit_index.py` — link, ownership, and publication-safety checks.

## Canonical decision ownership

Choose the narrowest owner that fully covers a current decision:

1. One semantic unit only: the unit document.
2. Multiple units in one module: the module document.
3. Multiple modules in one flow: a thread document.
4. Truly project-wide: `overview.md`.

Other layers may include one short current-state summary and a link to the canonical owner, but must not duplicate its rationale, alternatives, or history. Keep unresolved choices under an explicit `## Open Questions`/`Unconfirmed` heading rather than presenting speculation as a decision. Git history preserves superseded decisions; active pages should describe only current behavior and necessary persisted/external compatibility.

For a security, data-loss, persisted-data, or external-protocol invariant, repetition at an execution boundary is allowed only when the sentence is short and identical, carries the same stable invariant ID, and links to the canonical owner. Keep rationale and implementation detail only at that owner.

## File ownership and maintenance

Unit headers use:

```text
Files: path/to/primary.ts, path/to/primary.test.ts
Secondary files: package.json, path/to/integration.test.ts
```

`Files:` declares primary semantic ownership. `Secondary files:` records manifests, registration sites, integration tests, or files owned by another unit. Modules and threads navigate but do not claim source ownership. Prefer stable symbols/sections over brittle line numbers.

Maintenance workflow:

1. Read `overview.md`, then the relevant module/thread/unit documents.
2. Verify important claims against matching source and tests.
3. Select the canonical ownership level before recording a decision.
4. Update changed units for files, symbols, behavior, callers, tests, and integration notes.
5. Update a parent module only when its boundary, interface, invariant, or navigation changes.
6. Update a thread only when its cross-module flow changes.
7. Add links instead of duplicating decision prose.
8. Run the audit and review the diff for stale contracts, duplicate ownership, private data, and public readability.

## Compatibility and open questions

Use explicit labels:

- **Current behavior / Invariants:** what the checked source must do.
- **Compatibility:** persisted readers, migration evidence, URLs, protocols, or external shapes retained at a real boundary; state what old shape is read and what current shape is written.
- **Design Decisions:** why the current design exists, kept only at the canonical owner.
- **Open Questions:** unresolved product or architecture choices, never asserted as implementation.

## Audit

From the Foxwarm repository root:

```bash
npm run quality:code-index
```

The command runs `docs/code-index/scripts/audit_index.py` with the repository root as source tree and treats CJK content as an error. The audit checks local Markdown links, primary file existence/ownership, private-path and credential-like patterns, decision density, and likely near-duplicate decisions. Warnings require review; errors must be resolved before merging.
