# Code Index Top-Down Child Guide

You are a child/subagent session assigned to create or improve a project **code index** by reading source code and writing durable documentation under the assigned index root. During migration, repository-local `docs/code-index/` is preferred and `~/code-index/{project}/` is the fallback.

This guide is for the **agent-guided top-down traversal** method. It is different from the simpler bottom-up worker flow in `WORKER.md`.

## Mission

Build useful code-index docs while exploring the source like a developer:

- start from broad parent context;
- descend into directories/files;
- write bottom-level unit docs with awareness of the parent architecture;
- continuously update parent module docs as you learn;
- keep enough progress on disk that the task can survive session compaction, interruption, or handoff.

The goal is not just to list functions. A good unit doc explains how the unit fits into its parent module, how it relates to siblings, and what future coding agents should know before editing it.

## Terms

- **source root**: project repository or source tree being indexed.
- **index root**: the single root selected for this task; prefer `<repo-root>/docs/code-index/`, then fall back to `~/code-index/{project}/`.
- **overview doc**: `overview.md`, the project-wide navigation and architecture summary.
- **module doc**: `modules/...md`, a parent or subtree summary.
- **unit doc**: `units/...md`, a bottom-level semantic unit summary.
- **thread doc**: `threads/...md`, a cross-module flow.
- **context stack**: the docs that describe the ancestors of the source item you are about to inspect, e.g. `overview.md -> modules/a.md -> modules/a/b1.md`.
- **micro-batch**: the smallest chunk of new source understanding you will read before flushing docs. Usually one file, a tiny related group, or one section of a large file.
- **safe point**: the state after a micro-batch has been written into unit/ancestor docs and the progress file has been updated.

## Rules

- Source repos are read-only unless the parent explicitly says otherwise.
- Write only under the assigned index root, usually `~/code-index/{project}`.
- You may create/update `overview.md`, `modules/`, `units/`, `threads/`, and `_work/` only as needed for your assigned scope.
- Do not modify source files, git state, build outputs, dependencies, runtime data, or unrelated project files.
- Do not create child sessions.
- Prefer concise docs with practical coding guidance over exhaustive prose.
- Verify important facts against source paths. Mark uncertainty clearly.
- Keep the parent informed with a focused final report.
- Follow `SKILL.md` governance: public-safe English only, one primary-owning unit per source file, and exactly one canonical owner for each Design Decision.

## Governance While Traversing

- Never write secrets, real credentials, local usernames/home paths, private deployment/runbooks, or agent-private collaboration memory. If an environment-specific source-code literal is genuinely required, keep it minimal and label it `source-code literal`.
- Prefer source-relative paths, stable symbols, and section names over brittle line numbers.
- Separate files the unit owns from secondary/integration files it only references; do not let multiple units claim primary ownership of the same source file.
- Treat the index as a current map, not a changelog. Remove or replace superseded content; put unconfirmed ideas in `Open Questions` labeled `Unconfirmed`.
- Before recording a user-confirmed decision, choose one canonical owner: unit (one semantic unit), module (several units in one module), thread (cross-module end-to-end contract), or overview (project-wide principle). Write the full English decision/rationale/date only there. Other layers get one short summary and a canonical link.
- If several modules start repeating a decision, create or use a thread. Only critical security, data-integrity, persisted-data, or external-contract invariants may be repeated; use the same short sentence verbatim with the canonical link or ID.

## Why This Method Exists

A pure bottom-up generation flow looks like this:

```text
source files -> unit docs -> module docs -> overview
```

That is fast, but the unit docs are written before the agent understands the architecture. For example, a generated doc for `a/b1/c2` may list functions but miss that `c2` validates objects created by `c1`, or that `b1` is the parsing half of a larger `a` pipeline.

Top-down traversal instead carries parent context into each lower-level write:

```text
overview.md
  -> modules/a.md
    -> modules/a/b1.md
      -> units/a-b1-c1.md
      -> units/a-b1-c2.md
```

When writing `units/a-b1-c2.md`, you should already know the current understanding of `a` and `b1`, plus useful sibling facts from `c1` if it has been inspected. This creates better docs for future coding agents.

## Compaction and Interruption Safety

Long-running agent sessions can be compacted. That means old conversation turns may be summarized to keep the session within context limits. Even without formal compaction, an agent can lose detail after reading too much code.

So do **not** use the chat transcript as the only place where new understanding lives.

### Bad pattern

```text
1. Read all files under a/b1: c1 ... c20.
2. Keep your evolving understanding of b1 only in conversation context.
3. Plan to update modules/a/b1.md after every file has been read.
4. The session compacts or gets interrupted halfway.
5. Detailed understanding is lost, and parent docs never receive it.
```

### Good pattern

```text
1. Read c1.
2. Write/update units/a-b1-c1.md.
3. Immediately update modules/a/b1.md with what c1 revealed.
4. Update modules/a.md or overview.md if the new fact changes parent architecture.
5. Mark c1 complete in _work state only after those docs are flushed.
6. Move to c2, reloading parent docs from disk if needed.
```

Do not try to guess when compaction will happen. Instead use this invariant:

> Never keep more than one small micro-batch of new source understanding only in conversation context. Flush it into index docs before moving on.

## Context Stack Reloading

Before processing a source unit, make sure the relevant parent docs are available in your current context.

For source `a/b1/c2`, the context stack may be:

```text
overview.md
modules/a.md
modules/a/b1.md
units/a-b1-c1.md       # optional sibling context, useful if c1 was already inspected
```

If you are not sure whether these docs are still in context, read them again from disk. Do not spend time trying to infer whether compaction happened. The docs are intentionally concise and durable; rereading them is normal.

## Recommended Directory Conventions

Follow the convention assigned by the parent. If none is assigned:

- prefer nested module docs for source subtrees:

```text
modules/a.md
modules/a/b1.md
modules/a/b2.md
```

- use stable kebab-case unit names based on source path and semantic role:

```text
units/a-b1-c1.md
units/a-b1-validation.md
units/a-b1-parser.md
```

Document the chosen convention in `overview.md` or `_work/top-down-init.md`.

## Work State in `_work/`

Use `_work/` to make the run resumable. It records progress, not final architecture knowledge.

Suggested file:

```text
_work/top-down-init.md
```

Suggested contents:

```markdown
# Top-Down Code Index Init State

## Scope
- source root: /path/to/project
- index root: ~/code-index/project
- assigned source scope: a/b1
- module convention: nested modules, e.g. modules/a/b1.md
- unit convention: kebab path names, e.g. units/a-b1-c1.md

## Context Stack for Current Scope
- overview.md
- modules/a.md
- modules/a/b1.md

## Queue
- [x] a/b1/c1
- [ ] a/b1/c2
- [ ] a/b1/c3

## In Progress
- none

## Skipped / Deferred
- none

## Open Questions
- Need to inspect c2 before confirming whether validation belongs in b1 or b2.
```

Important: do not store the only copy of important architecture understanding in `_work/`. Put real knowledge in `overview.md`, `modules/`, `units/`, or `threads/`.

## Micro-Batch Loop

For each micro-batch:

1. **Select the next item** from `_work` queue or from the assigned source scope.
2. **Mark it in progress** in `_work` before reading a large amount of source.
3. **Load context stack** from index docs:
   - `overview.md` if it exists;
   - ancestor module docs;
   - nearest parent module doc;
   - relevant sibling unit/module docs when useful.
4. **Read source** for one micro-batch:
   - one normal file;
   - a tiny related group;
   - a test plus the source it validates;
   - one section/class/export of a very large file.
5. **Write/update unit doc** under `units/`, including current primary ownership, behavior, and stable-symbol function index as applicable.
6. **Update nearest parent module doc** immediately for current navigation and behavior, without copying a unit-owned decision.
7. **Propagate upward** if needed:
   - update a higher ancestor module if responsibility/boundary/interface changed;
   - update `overview.md` if the new fact changes project-level navigation;
   - create/update a `threads/` doc when a cross-module flow is clear enough or several modules would otherwise repeat one decision.
8. **Record uncertainty** in `Open Questions` or `Incomplete Areas` rather than pretending the subtree is fully understood.
9. **Update `_work` state last**:
   - remove `in progress`;
   - mark the item complete;
   - add newly discovered queue items or follow-ups.

If interrupted before step 9, repeat or reconcile the micro-batch later. Duplicate work is acceptable. Losing understanding is not.

## Rolling Parent Docs

Parent docs should be useful even while incomplete. Do not wait for an entire directory to be finished before writing a parent module doc.

Example partial parent doc:

```markdown
# Module: a/b1

## Responsibility
Current understanding: b1 appears to own parsing incoming records into normalized objects used by the rest of a.

## Children / Units
- `units/a-b1-c1.md` — source reader and first-stage parser. Inspected.
- `a/b1/c2` — pending; likely validation based on references from c1.
- `a/b1/c3` — pending.

## Interfaces and Relationships
- c1 appears to produce objects consumed by c2.
- b1 likely feeds b2, but b2 has not been inspected yet.

## Invariants and Constraints
- Current evidence suggests parsed records must keep stable IDs.

## Open Questions / Incomplete Areas
- Need to inspect c2 to confirm validation behavior.
- Need to inspect b2 to confirm downstream consumers.

## Design Decisions
```

Later, revise this doc as uncertainty becomes confirmed.

## Unit Doc Checklist

For each `units/{unitName}.md`, include:

- source files / sections covered;
- primary source files owned and secondary/integration files referenced;
- purpose in one or two sentences;
- how it fits the parent module;
- key exports / types / classes / functions, indexed by stable symbol or section;
- important internal functions when useful;
- inputs, outputs, side effects, state changes;
- dependencies on project modules;
- known callers or downstream consumers;
- related tests;
- pitfalls, invariants, and edge cases;
- open questions if the surrounding architecture is not fully inspected yet.

Suggested structure:

```markdown
# Unit: a-b1-c1

Files: a/b1/c1.ts

## Purpose

## Parent Context

## Key Exports

## Function Index (stable symbols/sections; line numbers optional)

## Dependencies and Callers

## Behavior and Side Effects

## Tests / Validation

## Pitfalls and Open Questions
```

## Module Doc Checklist

For each `modules/{modulePath}.md`, include:

- responsibility and boundaries;
- current completion status if still initializing;
- child modules / units;
- public interfaces / integration points;
- important internal data/control flow;
- invariants and constraints;
- related tests / validation strategy;
- pitfalls / historical context;
- open questions / incomplete areas;
- canonical design decisions owned by this module, plus summary links to decisions owned elsewhere.

Suggested structure:

```markdown
# Module: a/b1

## Responsibility

## Status

## Children / Units

## Public Interfaces

## Internal Flow

## Invariants and Constraints

## Tests / Validation

## Pitfalls and Open Questions

## Design Decisions
```

## When to Update Higher Ancestors

Always update the nearest parent module after each micro-batch, but update its navigation and current behavior rather than duplicating a lower-level decision.

Update higher ancestors (`modules/a.md`, `overview.md`, threads) when the micro-batch reveals or changes:

- module responsibility or boundaries;
- public interfaces;
- cross-module data/control flow;
- important invariants;
- naming conventions;
- user-confirmed design decisions whose selected canonical owner is that ancestor;
- warnings that future agents need before editing.

If the fact is local and does not change parent understanding, keep it in the nearest module and unit docs.

## Handling Large Directories

For a large directory such as `a/b1` with many or long files:

1. Create a rough `modules/a/b1.md` early.
2. Build a queue in `_work/top-down-init.md`.
3. Process one micro-batch at a time.
4. Update `modules/a/b1.md` after every micro-batch.
5. Reload `overview.md`, `modules/a.md`, and `modules/a/b1.md` whenever unsure they remain in context.
6. Leave clear pending markers for uninspected files.
7. Report progress and safe stopping points to the parent.

Do not read a large directory for hours and postpone all documentation until the end.

## Final Report Format

Send a concise report to the parent:

```text
## Completed
- Wrote/updated: <docs>
- Completed source items: <items>

## Current index state
- Overview/module context created or changed: <summary>
- Units created/updated: <summary>

## Remaining queue / suggested follow-up
- <scope/item> -> <doc> — <why>

## Notes / risks
- <uncertainty, skipped files, stale docs, or assumptions>
```

If no follow-up is needed, write `none`.
