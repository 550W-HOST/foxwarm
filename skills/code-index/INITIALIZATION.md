# Code Index Initialization

This document describes how to create a code index for a project when `~/code-index/{project}` does not exist yet or is too incomplete to be useful.

Most day-to-day work is **not** initialization. If an index already exists, usually read `overview.md`, search existing docs, inspect source, and make targeted updates. Use this document when you need to build the initial map.

## Initialization Goals

A useful initial code index should answer:

- What is this project?
- What are the main modules and boundaries?
- What are the important cross-module flows?
- Which files or semantic units should an agent read for a task?
- What design decisions, invariants, or pitfalls should future agents know?
- How does a bottom-level file/unit fit into its parent module and neighboring units?

The index is a durable map on disk. Do not rely on the current chat context as the only place where newly discovered architecture knowledge lives.

## Choose an Initialization Method

There are two complementary methods.

### Method 1: Batch Generator / Bottom-Up Map-Reduce

Use this when you want a fast first draft:

```text
source files -> units -> modules -> threads -> overview
```

Pros:

- fast to bootstrap;
- easy to run on many files;
- good when source structure already reflects architecture clearly;
- useful as a rough starting point before manual cleanup.

Cons:

- early unit docs are written before the model understands the whole project;
- bottom-level docs may list functions but miss architectural relationships;
- full regeneration can overwrite curated docs, so avoid routine full reruns after humans/agents have improved the index.

Use `WORKER.md` when assigning simple workers to inspect a fixed scope and write assigned docs in this style.

### Method 2: Agent-Guided Top-Down Traversal

Use this when quality matters more than speed, especially for first-time indexing of a large or unfamiliar codebase.

The agent explores like a developer and carries parent context into child docs:

```text
overview.md
  -> modules/a.md
    -> modules/a/b1.md
      -> units/a-b1-c1.md
      -> units/a-b1-c2.md
```

Pros:

- better architecture-aware unit docs;
- parent/child relationships are discovered and recorded while reading;
- robust against compaction/interruption when using micro-batch checkpoints;
- good for complex projects where directory names alone do not explain design.

Cons:

- slower;
- requires more careful child-session coordination;
- may need multiple passes to finish a large repository.

Use `TOP_DOWN_CHILD.md` as the prompt for a child/subagent session assigned to this method.

## Method 1 Details: Batch Generator

The batch generator is implemented as a Foxwarm ToolScript:

```text
skills/code-index/generate_code_index.py
```

Run it through Foxwarm's `run_script` tool. It is not a standalone Python CLI because it uses ToolScript host APIs such as `call_tool(...)` and `request_model_without_context(...)`.

### Phases

1. **Scan & Plan** — list source files, get sizes, call a model to plan semantic unit groupings.
2. **Units** — read source files for each unit group and generate `units/*.md`.
3. **Modules** — generate `modules/*.md` from unit summaries.
4. **Threads** — generate `threads/*.md` from module summaries.
5. **Overview** — generate `overview.md` from modules and threads.

Design decisions are not extracted by the generator. Add decisions from actual task/user context to relevant `## Design Decisions` sections.

### Running

```python
# Full generation
run_script(filePath="skills/code-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project"})

# Single phase
run_script(filePath="skills/code-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project", "phase": "units"})

# Test with specific files only
run_script(filePath="skills/code-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project", "phase": "units", "files": ["src/main.ts", "src/server.ts"]})
```

The script may need multiple `continue_script` calls for large projects. Use a larger timeout, such as `timeoutSecs: 120`, for batch runs.

### After Generation

Review and clean up generated docs:

- fix incorrect module names or groupings;
- add missing architectural relationships;
- remove hallucinated claims;
- verify important details against source;
- add confirmed design decisions manually;
- decide whether any area needs a top-down follow-up pass.

## Method 2 Details: Top-Down Context-Carrying Traversal

This method intentionally lets information flow from parent docs to child docs.

Example source tree:

```text
a/
  b1/
    c1
    c2
    c3
  b2/
    c4
    c5
    c6
```

A top-down initialization could proceed like this:

1. Inspect the repository root and create a rough `overview.md`.
2. Inspect `a/` enough to create `modules/a.md` with current understanding and open questions.
3. Inspect `a/b1/c1` and create/update:
   - `modules/a.md`;
   - `modules/a/b1.md`;
   - `units/a-b1-c1.md`.
4. Before inspecting `a/b1/c2`, load the current context stack:
   - `overview.md`;
   - `modules/a.md`;
   - `modules/a/b1.md`;
   - relevant sibling unit docs such as `units/a-b1-c1.md` when useful.
5. Inspect `c2`, then update `units/a-b1-c2.md` and revise `modules/a/b1.md` immediately.
6. Continue in small checkpoints until the subtree is complete.

A unit doc written this way can say “this file implements the parser half of b1’s pipeline and feeds c2’s validator” instead of only listing function names.

## Compaction and Interruption Safety

Long-running agent sessions can be compacted: older turns may be summarized so the model can keep working within context limits. Even without automatic compaction, an agent can simply lose detail after reading too much.

So initialization must be checkpoint-safe.

### Bad Pattern

```text
1. Read all files under a/b1: c1 ... c20.
2. Keep your evolving understanding of b1 only in conversation context.
3. Plan to update modules/a/b1.md after every file has been read.
4. The session compacts or gets interrupted halfway.
5. Detailed understanding is lost, and parent docs never receive it.
```

### Good Pattern

```text
1. Read c1.
2. Write/update units/a-b1-c1.md.
3. Immediately update modules/a/b1.md with what c1 revealed.
4. Update modules/a.md or overview.md if the new fact changes parent architecture.
5. Mark c1 complete in _work state only after those docs are flushed.
6. Move to c2, reloading parent docs from disk if needed.
```

Do not try to guess when compaction will happen. Use this invariant instead:

> Never keep more than one small micro-batch of new source understanding only in conversation context. Flush it into index docs before moving on.

## Context Stack

Before processing a source unit, the child session should have the current ancestor context.

For source `a/b1/c2`, the context stack may be:

```text
overview.md
modules/a.md
modules/a/b1.md
units/a-b1-c1.md       # optional sibling context, useful if c1 was already inspected
```

If the child is unsure whether these docs are still in context, it should read them again from disk. Do not spend effort inferring whether compaction happened. Rereading concise docs is normal; the docs are the durable memory for the indexing run.

## Micro-Batch Safe Points

A micro-batch may be:

- one normal source file;
- a small group of closely related tiny files;
- one test file plus the source file it validates;
- one section/class/export of a very large file.

After each micro-batch, reach a safe point:

1. Unit doc is written or updated.
2. Nearest parent module doc is updated.
3. Important changes are propagated upward, or explicitly recorded as open questions / pending follow-up.
4. `_work` state is updated only after docs are flushed.

If interrupted before `_work` is updated, repeat or reconcile that micro-batch later. Duplicate work is acceptable. Losing understanding is not.

## Rolling Parent Docs

Do not wait for an entire directory to be complete before writing a parent module doc. Parent docs should be useful while partial.

Example:

```markdown
# Module: a/b1

## Responsibility
Current understanding: b1 appears to own parsing incoming records into normalized objects used by the rest of a.

## Status
Partially initialized. c1 inspected; c2 and c3 pending.

## Children / Units
- `units/a-b1-c1.md` — source reader and first-stage parser. Inspected.
- `a/b1/c2` — pending; likely validation based on references from c1.
- `a/b1/c3` — pending.

## Interfaces and Relationships
- c1 appears to produce objects consumed by c2.
- b1 likely feeds b2, but b2 has not been inspected yet.

## Open Questions / Incomplete Areas
- Need to inspect c2 to confirm validation behavior.
- Need to inspect b2 to confirm downstream consumers.

## Design Decisions
```

As more units are inspected, revise the parent doc to replace uncertainty with confirmed structure.

## `_work` State

Use `_work/` to make initialization resumable. It records progress, not final architecture knowledge.

Suggested file:

```text
~/code-index/{project}/_work/top-down-init.md
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

Do not store important architecture understanding only in `_work`; put real knowledge in `overview.md`, `modules/`, `units/`, or `threads/`.

## Top-Down Child/Subagent Handoff

When creating a child/subagent session for top-down initialization, tell it to read `TOP_DOWN_CHILD.md` and include:

- source root;
- index root;
- assigned source scope;
- allowed index paths to write;
- module/unit naming convention, if known;
- whether source repo is read-only;
- expected report format;
- any existing docs or `_work` state to resume from.

Do not ask multiple children to update the same module docs concurrently unless you intentionally coordinate ownership. Shared parent docs such as `overview.md` and `modules/a.md` can conflict if many workers edit them at the same time.

A safe parallelization strategy is:

- one coordinator owns `overview.md` and high-level module docs;
- each child owns a disjoint subtree;
- children update their nearest parent docs within that subtree;
- the coordinator later reconciles top-level summaries.

## When Initialization Is Done

An initial index is good enough when:

- `overview.md` gives a useful project map;
- important modules have docs with responsibilities and boundaries;
- common cross-module flows have thread docs, or at least clear pointers from modules;
- bottom-level units cover the files likely to be edited soon;
- incomplete areas are clearly marked;
- future agents know where to continue indexing.

It does not need to cover every file perfectly before it becomes useful.
