---
name: code-index
description: "Use and maintain layered project code indexes: architecture overview, module/thread docs, semantic units, and governed design decisions."
---

# Code Index

A **code index** is a layered, agent-oriented map of a source repository. It helps development agents orient themselves before editing code, but it is not the source of truth. Verify important claims against current source before making risky changes.

## Resolve the Index Root

During the repository-local migration, resolve the index root in this order:

1. Prefer `<repo-root>/docs/code-index/` when it exists.
2. Otherwise fall back to an existing `~/code-index/{project}/` index until migration is complete.
3. If neither exists, follow the initialization workflow; prefer the repository-local location for a new index unless the project explicitly uses another convention.
4. Use one resolved root for the whole task. Do not split updates across both locations or copy an existing index merely to satisfy this lookup rule.

In the rest of this skill, `<index-root>` means that resolved directory.

```text
<index-root>/
├── overview.md          # Project-wide architecture, principles, navigation
├── threads/             # Cross-module end-to-end contracts and flows
├── modules/             # Module/subtree summaries
├── units/               # Bottom-level semantic unit summaries
└── _work/               # Optional temporary initialization/checkpoint state
```

## Most Common Workflow: Read or Update an Existing Index

Before inspecting or modifying code:

1. Resolve the index root and read `<index-root>/overview.md`.
2. Search the index first: `rg "<term>" <index-root>`.
3. Read relevant `modules/` and `threads/` docs.
4. Read relevant `units/` docs for file and semantic-unit detail.
5. Read code-index Markdown files as whole files by default. They should remain small enough to skim. If one is genuinely large, locate the needed section first, especially `## Design Decisions`.
6. Verify important claims against source.

After changing source:

1. Update the affected unit's current file ownership, purpose, behavior, exports, stable-symbol function index, tests, and integration notes as applicable.
2. Update affected module/thread/overview navigation and current behavior or contracts.
3. Before writing any decision, choose its one canonical owner. Updating several related docs does **not** mean appending the same decision to every layer.
4. Run available code-index checks and review the diff for stale or duplicated material.

## Document Roles and Ownership

### `overview.md`

Project-wide overview: what the project is, module map, core principles, tech stack, project-wide invariants, and where to start reading.

### `modules/{name}.md`

A module or source-subtree summary: responsibility, boundaries, children, public interfaces, current invariants, tests, pitfalls, and navigation. Nested module docs are allowed when useful.

### `threads/{name}.md`

A cross-module end-to-end contract or flow, such as request lifecycle, state persistence, tool dispatch, streaming, or an external integration. When several modules begin repeating the same decision, treat that as a signal to create or use a thread doc as the canonical owner.

### `units/{name}.md`

A bottom-level semantic unit: one file, a small related file group, or one large-file section/class/export. Explain purpose, parent context, stable symbols, dependencies/callers, behavior, side effects, edge cases, tests, and integration.

Each source file should have at most one unit claiming **primary ownership**. A unit may list other files as **secondary/integration references**, but must not imply that it owns them. Prefer stable symbols and section names over brittle line numbers; add line numbers only when they materially help and are likely to remain useful.

## Public-Safe, English-Only Content

A code index may be committed or shared. Keep all final index content public-safe and in English.

Do not write:

- secrets, tokens, private keys, or real credentials;
- local usernames, machine-specific home-directory paths, or private host layout;
- private deployment/runbook details;
- agent-private collaboration notes, personal memory, or chat-only operational context.

Use source-relative paths and generic placeholders instead. Never copy a real secret value. If behavior genuinely depends on a source-code literal that would otherwise look environment- or deployment-specific, include only the minimum necessary literal and label it explicitly as a **source-code literal**, not as a live value or recommendation.

Translate user-confirmed Design Decisions accurately into English. Preserve the contract and rationale; do not preserve private wording or identifying details that are not part of the software contract.

## Design Decision Governance

The index is an **active map**, not an append-only changelog.

- Keep only the currently effective, user-confirmed contract and useful rationale.
- Replace or remove superseded text; Git history preserves old versions.
- Put unconfirmed ideas in `## Open Questions`, explicitly labeled `Unconfirmed`, rather than in `## Design Decisions`.
- Curate or split a document when decision density makes it hard to navigate.

Every decision has exactly one canonical owner:

| Owner | Use when the contract applies to |
| --- | --- |
| Unit | One semantic unit only |
| Module | Multiple units inside one module |
| Thread | Multiple modules in one end-to-end contract or flow |
| Overview | The whole project as a general principle |

Choose the narrowest owner that fully covers the contract. Record the full decision, rationale, and date only there. If another layer needs visibility, write one short English summary plus a link to the canonical decision; do not duplicate the full decision, rationale, or date. Give frequently referenced decisions a stable ID or stable heading so links survive nearby edits.

Exception: a critical security, data-integrity, persisted-data, or external-contract invariant may be repeated where omission would create material risk. The repeated text must be the same short sentence verbatim and include the canonical decision link or ID. Keep all rationale and history only at the canonical owner.

## Maintenance Quality Checks

Keep docs concise and navigational. Prefer practical coding guidance and stable terminology over exhaustive prose. Do not routinely regenerate a curated index; use targeted updates, and correct docs whenever they conflict with source.

Use project-provided lint/check scripts when available. Otherwise review or automate checks for:

- broken internal links and missing referenced files;
- multiple units claiming primary ownership of one source file;
- secrets, credential-shaped values, local usernames, and home-directory paths;
- CJK or other non-English prose in maintained docs;
- inconsistent terminology and unstable line-number-heavy references;
- suspiciously similar Design Decisions across unit/module/thread/overview layers.

Similar decisions should trigger owner reconciliation, not automatic deletion: select the canonical owner, replace other copies with summary links, and create/use a thread when the contract crosses modules.

## Creating a New Index

First-time initialization is less common than targeted maintenance. Read `INITIALIZATION.md` before assigning workers or running a generator. Supporting resources include:

- `WORKER.md` — assigned-scope/bottom-up worker guide;
- `TOP_DOWN_CHILD.md` — context-carrying top-down traversal guide;
- `generate_code_index.py` — Foxwarm ToolScript-compatible batch generator;
- `generate_code_index_standalone.py` — standalone Python batch generator;
- `tests/test_generate_code_index.py` — generator safety and governance tests.

The ToolScript generator runs in Monty's Python subset, not CPython. It stays self-contained, uses only Monty's bundled `json` module, and reaches host files or processes exclusively through `call_tool(...)`; use the standalone generator when ordinary Python libraries are required.

Generators create a first draft only. Review generated content under this skill's public-safety, ownership, decision, and maintenance rules before treating it as an active index.
