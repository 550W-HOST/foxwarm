---
name: code-index
description: "Use and maintain layered project code indexes: architecture overview, optional behavior contracts, module/thread docs, semantic units, and governed design decisions."
---

# Code Index

A **code index** is a layered, agent-oriented map of a source repository. It locates code and records current contracts and their rationale; it does not establish requirements merely by describing an implementation. Confirmed design decisions and supported compatibility contracts constrain changes. Source and tests provide evidence of actual behavior; report conflicts instead of silently changing a contract to fit the code.

## Resolve the Index Root

During the repository-local migration, resolve the index root in this order:

1. Prefer `<repo-root>/docs/code-index/` when it exists.
2. Otherwise fall back to an existing `~/code-index/{project}/` index until migration is complete.
3. If neither exists, follow the initialization workflow; prefer the repository-local location for a new index unless the project explicitly uses another convention.
4. Use one resolved root for the whole task. Do not split updates across both locations or copy an existing index merely to satisfy this lookup rule.

In the rest of this skill, `<index-root>` means that resolved directory.

```text
<index-root>/
├── overview.md          # Project entry, architecture, principles, local conventions
├── behaviors/           # Optional observable user/runtime-Agent contracts
├── threads/             # Cross-module end-to-end contracts and flows
├── modules/             # Module/subtree summaries
├── units/               # Bottom-level semantic unit summaries
└── _work/               # Optional temporary initialization/checkpoint state
```

## Most Common Workflow: Read or Update an Existing Index

Before inspecting or modifying code:

1. Resolve the index root. A fresh Session must read relevant Code Index context before changing source or assigning implementation; a source search alone does not replace this step.
2. Start at the smallest entry that covers the task. Read `overview.md` when the repository or subsystem is unfamiliar; otherwise use the relevant behavior, module, thread, or unit directly. A repository may omit the behavior layer; read it only when relevant, not as an extra mandatory traversal step.
3. Identify the few governing contracts and reasons relevant to the task. Follow dependencies when a boundary or material question needs clarification; do not visit every index layer merely to complete a sequence.
4. Reuse relevant context already read in this Session when it is still current. Read the affected sections after a branch change, conflicting evidence, or new scope; a new small edit does not by itself require rereading unchanged documents.
5. Verify material claims against source. For translation or replacement, compare the original caller path from entry to observable effects with the new path; a feature summary or the new implementation's own tests cannot establish parity. If source and a recorded contract disagree, identify whether the code or documentation needs correction rather than assuming either is correct.

After changing source:

1. Update only changed contracts, responsibilities, and navigation. Preserve useful source-entry and stable-symbol references; do not narrate every helper, branch, or test run.
2. Update a parent or thread only when its own boundary, interface, flow, or navigation changes. A file split may need only ownership and symbol-reference updates.
3. Choose one canonical owner for each decision. Replace superseded text and remove redundant detail instead of appending another account of the change.
4. Run available index checks and review the documentation diff. Structural checks do not prove behavioral correctness or parity.

## Document Roles and Ownership

### `overview.md`

The project entry point: architecture, project-wide principles, module/thread navigation, and necessary repository-specific conventions. Avoid a separate governance entry that readers must discover; do not copy the full generic skill into the overview.

### `behaviors/{name}.md` (optional)

Observable user/runtime-Agent contracts organized around developer questions, actions, and consequences. Link to technical owners for mechanisms, precise protocol/storage invariants, and source/test entry points. Keep each contract at one canonical owner rather than duplicating full rules across behavior and technical pages.

### `modules/{name}.md`

A module or source-subtree summary: responsibility, boundaries, children, public interfaces, current invariants, tests, pitfalls, and navigation. Nested module docs are allowed when useful.

### `threads/{name}.md`

A cross-module end-to-end contract or flow, such as request lifecycle, state persistence, tool dispatch, streaming, or an external integration. When several modules begin repeating the same decision, treat that as a signal to create or use a thread doc as the canonical owner.

### `units/{name}.md`

A bottom-level semantic unit: one file, a small related file group, or one large-file section/class/export. Keep the contracts, caller boundaries, side effects, and source/test entry points needed to change it correctly. Do not turn the unit into a line-by-line account of its implementation.

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

The index is an **active map**, not an append-only changelog. Lead each page with its important constraints and useful rationale, or links to their canonical owners, before implementation detail. Use existing headings where suitable; this is an information priority, not a mandatory template or another checklist.

- Keep only the currently effective, user-confirmed contract and useful rationale.
- Replace or remove superseded text; Git history preserves old versions.
- Put unconfirmed ideas in `## Open Questions`, explicitly labeled `Unconfirmed`, rather than in `## Design Decisions`.
- Remove stale, duplicated, or incidental detail first; split by responsibility when the remaining useful content is still hard to navigate. Do not drop effective contracts merely to shorten a page.

Every decision has exactly one canonical owner:

| Owner | Use when the contract applies to |
| --- | --- |
| Behavior (optional) | An observable user/runtime-Agent contract, with linked technical owners |
| Unit | One semantic unit only |
| Module | Multiple units inside one module |
| Thread | Multiple modules in one end-to-end contract or flow |
| Overview | The whole project as a general principle |

Choose the narrowest owner that fully covers the contract. Record the full decision, rationale, and date only there. If another layer needs visibility, write one short English summary plus a link to the canonical decision; do not duplicate the full decision, rationale, or date. Give frequently referenced decisions a stable ID or stable heading so links survive nearby edits.

Exception: a critical security, data-integrity, persisted-data, or external-contract invariant may be repeated where omission would create material risk. The repeated text must be the same short sentence verbatim and include the canonical decision link or ID. Keep all rationale and history only at the canonical owner.

## Maintenance Quality Checks

Keep docs concise and navigational. Retain details that explain an implementation constraint, prevent a known regression, or locate relevant code. Do not routinely regenerate a curated index. Resolve discrepancies with source under the contract/evidence distinction above, then update the affected content.

Use project-provided lint/check scripts when available. Otherwise review or automate checks for:

- broken internal links and missing referenced files;
- multiple units claiming primary ownership of one source file;
- secrets, credential-shaped values, local usernames, and home-directory paths;
- CJK or other non-English prose in maintained docs;
- inconsistent terminology and unstable line-number-heavy references;
- suspiciously similar Design Decisions across behavior/unit/module/thread/overview layers.

Similar decisions should trigger owner reconciliation, not automatic deletion: select the canonical owner and replace other copies with summary links. Use an optional behavior page for observable contracts where that layer exists, or a thread for cross-module mechanisms.

## Creating a New Index

First-time initialization is less common than targeted maintenance. Read `INITIALIZATION.md` before assigning workers or running a generator. Supporting resources include:

- `WORKER.md` — assigned-scope/bottom-up worker guide;
- `TOP_DOWN_CHILD.md` — context-carrying top-down traversal guide;
- `generate_code_index.py` — Foxwarm ToolScript-compatible batch generator;
- `generate_code_index_standalone.py` — standalone Python batch generator;
- `tests/test_generate_code_index.py` — generator safety and governance tests.

The ToolScript generator runs in Monty's Python subset, not CPython. It stays self-contained, uses only Monty's bundled `json` module, and reaches host files or processes exclusively through `call_tool(...)`; use the standalone generator when ordinary Python libraries are required.

Generators create a first draft only. Review generated content under this skill's public-safety, ownership, decision, and maintenance rules before treating it as an active index.
