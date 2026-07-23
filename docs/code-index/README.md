# Foxwarm Code Index

This repository is a curated navigation layer for the Foxwarm source tree. It is intended to be publishable as a sanitized snapshot under `docs/code-index/`.

## Authority and scope

- **Source code and tests are the source of truth.** The index helps readers find and understand code; it does not override implementation.
- **Public-safe content only.** Do not record credentials, tokens, private repository names, personal filesystem paths, deployment addresses, internal hostnames, private runbooks, or live-environment procedures.
- **English only.** Public snapshots must contain no CJK prose. Compatibility literals that are part of source code or persisted data may be quoted when necessary.
- **Active map, not changelog.** Keep the current contract. Git history preserves superseded decisions.
- **Verify before publishing.** Run the audit script against the matching Foxwarm checkout.

## Information architecture

### `overview.md`

Owns project-wide architecture, stable project principles, and navigation to modules and cross-module threads. It must remain short.

### `modules/*.md`

A module owns a source subtree or cohesive subsystem. A module document describes responsibility, boundaries, public interfaces, module-wide invariants, child units, and decisions that affect multiple units in that module.

### `threads/*.md`

A thread owns an end-to-end flow that crosses module boundaries. If the same decision would otherwise be copied into multiple modules, that is a signal to create or use a thread.

### `units/*.md`

A unit owns one bottom-level semantic implementation unit: one file, one large-file section, or a small cohesive file group. Unit documents describe concrete exports, behavior, dependencies, and unit-local decisions.

## Canonical decision ownership

Every decision has exactly one canonical owner:

1. One semantic unit only: the unit document.
2. Multiple units in one module: the module document.
3. Multiple modules in one flow: a thread document.
4. Truly project-wide: `overview.md`.

Other documents may include one short current-state summary and a link to the canonical decision. They must not copy its date, rationale, alternatives, or detailed contract.

Use stable decision headings or explicit IDs when another document needs to link to a decision. Prefer current-state prose over dated append-only bullets.

### Repeating critical invariants

A security, data-loss, persisted-data, or external-protocol invariant may be repeated at an execution boundary only when all of the following hold:

- the repeated sentence is short and byte-for-byte identical;
- it carries the same stable invariant ID;
- it links to the canonical owner;
- rationale and implementation details remain only at the canonical owner.

Ordinary UX, internal API, workflow, and styling decisions do not qualify.

## Current behavior, compatibility, and open questions

Use these concepts deliberately:

- **Current behavior / Invariants:** what the current source must do.
- **Compatibility:** readers or migrations retained for persisted user data or external contracts. State what old shape is read and what new shape is written.
- **Design Decisions:** why the current design was chosen or why an alternative was rejected. Keep these only at the canonical owner.
- **Open Questions:** unresolved product or architecture choices. Label them explicitly; do not present speculation as a decision.

Delete superseded implementation history from the active index. If a migration requires context, keep one concise compatibility note and rely on Git history for the rest.

## File ownership

Unit headers use:

```text
Files: path/to/primary.ts, path/to/primary.test.ts
Secondary files: package.json, path/to/integration.test.ts
```

- `Files:` declares primary semantic ownership. A source path must have only one primary unit owner.
- `Secondary files:` records shared manifests, integration tests, registration sites, or files owned by another unit.
- Module and thread documents link to units; they do not declare source-file ownership.

## Maintenance workflow

1. Read `overview.md`, then the relevant module/thread/unit documents.
2. Verify important claims against the matching source and tests.
3. Decide the canonical ownership level before recording a decision.
4. Update changed units for exports, files, behavior, and tests.
5. Update a parent module only when its boundary, interface, invariant, or navigation changed.
6. Update a thread only when the end-to-end flow changed.
7. Add links instead of duplicate decision prose.
8. Run the audit script.

## Audit

From the Foxwarm repository root:

```bash
npm run quality:code-index
```

The command runs `docs/code-index/scripts/audit_index.py` with the repository root as the source tree and treats CJK content as an error. The audit checks local Markdown links, primary file existence and ownership, private-path and credential-like patterns, decision density, and likely near-duplicate decisions. Warnings require review; errors must be resolved before merging.
