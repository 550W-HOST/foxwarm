---
name: code-index
description: "Use and maintain project code indexes under ~/code-index/{project}: architecture overview, module/thread docs, semantic units, and design decisions."
---

# Code Index

A **code index** is a layered, agent-oriented documentation tree stored outside the source repo. It helps development agents quickly understand a project before editing code.

```text
~/code-index/{project}/
├── overview.md          # Project-wide architecture, principles, navigation
├── threads/             # Cross-module feature flows
├── modules/             # Module/subtree summaries
├── units/               # Bottom-level semantic unit summaries
└── _work/               # Optional temporary initialization/checkpoint state
```

The index is a **map**, not the source of truth. Use it to orient yourself, then verify important details against current source before making risky changes.

## Most Common Use: Read or Update an Existing Index

When you are about to inspect or modify code:

1. Read `~/code-index/{project}/overview.md` for orientation.
2. Search the index first: `rg "<term>" ~/code-index/{project}`.
3. Read relevant `modules/` and `threads/` docs.
4. Read relevant `units/` docs for file/semantic-unit detail.
5. Read code-index markdown files **as whole files by default**. These docs should stay small enough to skim. If a doc is genuinely large, use `rg` to locate the needed section first, especially `## Design Decisions`.
6. Verify important claims against source code before editing.
7. After changing source code, update the corresponding unit/module/thread docs.

## Structure

### `overview.md`

Project-wide overview: what the project is, module map, core design principles, tech stack, key invariants, and where to start reading.

### `modules/{name}.md`

Module or source-subtree summaries. They cover responsibility, boundaries, child modules/units, public interfaces, invariants, tests/validation, pitfalls, and relevant design decisions.

Nested module docs are allowed when useful:

```text
modules/a.md
modules/a/b1.md
modules/a/b2.md
```

If a project uses flat filenames instead, document the convention in `overview.md`.

### `threads/{name}.md`

Cross-module feature flows, such as request lifecycle, state persistence, tool dispatch, streaming pipeline, or external integration flow.

### `units/{name}.md`

Bottom-level semantic units. A unit may be one file, a small related file group, or one large-file section/class/export. Unit docs should explain purpose, key exports/functions, dependencies/callers, side effects, edge cases, tests, and how the unit fits into its parent module.

## Design Decisions

Record user-confirmed design decisions in the relevant module/thread docs under `## Design Decisions`:

```markdown
## Design Decisions

- [2026-03-15] Background jobs must commit state only at safe points.
- [2026-05-30] Directory listing is handled by the file-read tool.
```

Decision notes should mainly come from actual user decisions or user-confirmed elaborations. Do not record an agent's unconfirmed guess as a decision. If an uncertain judgment must be preserved, label it clearly as unconfirmed / agent speculation.

Decision extraction is not built into this skill because the correct source depends on actual usage context.

## Creating a New Index

First-time index creation is less common than reading/updating an existing index, so the detailed workflow is in a companion document:

- `INITIALIZATION.md` — choose and run an initial creation method:
  - batch generator / bottom-up map-reduce;
  - agent-guided top-down traversal with compaction-safe checkpoints.
- `WORKER.md` — prompt for a simple assigned-scope/bottom-up worker.
- `TOP_DOWN_CHILD.md` — prompt for a child/subagent session doing top-down/context-carrying traversal.
- `generate_code_index.py` — Foxwarm ToolScript batch generator for a fast first draft.

When initializing a code index from scratch, explicitly read `INITIALIZATION.md` from this skill directory before assigning workers or running the generator.

## Maintenance Guidelines

- Keep docs concise and navigational.
- Prefer practical coding guidance over generic summaries.
- Keep `overview.md` and parent module docs current enough that a future agent can choose where to read next.
- Update units/modules/threads as part of source-code changes.
- Do not routinely regenerate the whole index once humans/agents have curated it; prefer targeted updates.
- If generated docs conflict with source, source wins and docs should be corrected.
