# Code Index Initialization

This document describes how to create a code index when no usable index exists. Prefer repository-local `<repo-root>/docs/code-index/` for a new index unless the project explicitly uses another convention. The `~/code-index/{project}/` fallback exists so maintenance can continue on an already existing legacy index during migration; do not create a second copy merely to satisfy the lookup order. Select one root for the run and do not split writes between both.

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

There are two supported batch runners. The standalone Python runner is:

```text
skills/code-index/generate_code_index_standalone.py
```

It calls models via the production `foxwarm model` CLI (no Foxwarm server process is required). Run it directly with `python3`. The existing `generate_code_index.py` remains the Foxwarm ToolScript-compatible runner for `run_script`; the standalone runner is an additional shell/background-friendly path, not a replacement for existing ToolScript automation or ordinary targeted maintenance through the skill.

### Prerequisites

- Build Foxwarm first with `npm run build`; the CLI reuses `lib/config.js` and `lib/llm.js` rather than maintaining a second provider stack.
- If an installed `foxwarm` executable is not on `PATH`, the generator automatically uses the repo-local `node scripts/foxwarm.js` entry. `FOXWARM_CLI` or `--foxwarm-cli` can explicitly select another command.
- The selected model key must be available through Foxwarm's normal model-config resolution.

### Phases

1. **Scan & Plan** — list eligible source files, get sizes, call a model to plan semantic unit groupings, and strictly validate that the plan uses every scanned file exactly once. Results are cached to `_work/groupings.json` with a source/files/project/model/CLI/timeout fingerprint.
2. **Units** — read allowlisted source files for each unit group and generate `units/*.md` with atomic writes. Existing non-empty docs are preserved unless `--force` is explicit.
3. **Modules** — generate `modules/*.md` from unit summaries.
4. **Threads** — generate `threads/*.md` from module summaries.
5. **Overview** — generate `overview.md` from modules and threads.

Design decisions are not extracted by the generator. Add only user-confirmed decisions from actual task context, following `SKILL.md`: choose one canonical owner before writing, use a thread for cross-module contracts, and use summary links rather than copying one decision across layers.

### Running

The runners retain their legacy `~/code-index/{project}/` default for existing automation. For a new repository-local index, pass `--output /path/to/project/docs/code-index` (or the equivalent ToolScript `output` argument) explicitly.

```bash
# Full generation
python3 skills/code-index/generate_code_index_standalone.py --project my-project --source /path/to/my-project --output /path/to/my-project/docs/code-index --model gpu44

# Single phase (resume from cached groupings)
python3 skills/code-index/generate_code_index_standalone.py --project my-project --source /path/to/my-project --output /path/to/my-project/docs/code-index --model gpu44 --phase units

# Test with specific files only
python3 skills/code-index/generate_code_index_standalone.py --project my-project --source /path/to/my-project --output /path/to/my-project/docs/code-index --model gpu44 --phase units --files src/main.ts,src/server.ts

# Override output directory
python3 skills/code-index/generate_code_index_standalone.py --project my-project --source /path/to/my-project --model gpu44 --output /custom/index/path

# Explicitly regenerate existing documents (may replace manual edits/Design Decisions)
python3 skills/code-index/generate_code_index_standalone.py --project my-project --source /path/to/my-project --output /path/to/my-project/docs/code-index --model gpu44 --force
```

Options:
- `--project` — project name (used for `~/code-index/{project}/`; defaults to source dir name)
- `--source` — path to project source root (defaults to current directory)
- `--phase` — run only this phase: `plan`, `units`, `modules`, `threads`, `overview`, `all` (default: all)
- `--files` — restrict to specific files (comma-separated, for testing)
- `--output` — override output directory
- `--model` — model key to use (default: foxwarm default model)
- `--timeout` — timeout in seconds per model call (default: 120)
- `--foxwarm-cli` — explicit Foxwarm CLI command (also configurable with `FOXWARM_CLI`)
- `--force` — replace existing generated docs; this is explicit confirmation that manual edits and Design Decisions may be overwritten

For large projects the script can take a long time (each unit ~60s). Run it in the background and check the log:

```bash
python3 skills/code-index/generate_code_index_standalone.py --project my-project --source /path/to/project --model gpu44 > /tmp/code-index.log 2>&1 &
```

The script is resumable: it reuses `_work/groupings.json` only when its fingerprint matches the current source/file selection/project/model/CLI/timeout. Existing non-empty units are resumed individually; an existing module, thread, or overview phase is retained as a whole unless `--force` is explicit, which avoids mixing a new model plan into curated docs. Empty or failed model responses are never written. Absolute paths, parent traversal, files outside the scanned allowlist, unsafe output-directory symlinks, and unsafe model-generated names are rejected. Use a separate output directory for experiments; use `--force` only after reviewing what it may replace.

### ToolScript-compatible runner

Existing Foxwarm automation can continue using the original ToolScript entry:

```python
run_script(filePath="skills/code-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project", "output": "/path/to/my-project/docs/code-index"})
```

It uses ToolScript host APIs such as `call_tool(...)` and `request_model_without_context(...)`; do not run that compatibility entry with ordinary Python. Prefer the standalone runner when you need strict path/output validation, fingerprinted resume state, or a long-running shell/background job.

### After Generation

Review and clean up generated docs:

- fix incorrect module names or groupings;
- add missing architectural relationships;
- remove hallucinated claims;
- verify important details against source;
- make all final prose public-safe English and remove secrets, credentials, local usernames/home paths, private runbooks, and agent-private memory;
- distinguish each unit's primary files from secondary/integration references and reconcile duplicate primary ownership;
- add confirmed design decisions manually at one canonical owner; repeated module decisions should become a thread-owned decision plus summary links;
- move unconfirmed ideas to `Open Questions` with an `Unconfirmed` label, and remove superseded history rather than preserving an append-only changelog;
- prefer stable symbols/sections over brittle line numbers and run available link/file/ownership/secret/CJK/terminology/similar-decision checks;
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
3. Immediately update modules/a/b1.md with current navigation and behavior revealed by c1.
4. Update modules/a.md, a thread, or overview.md if the new fact changes its owned architecture or contract; link rather than copying decisions owned lower down.
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
3. Important navigation and current behavior are propagated upward; decisions remain at their selected canonical owner, and uncertainty is explicitly recorded as `Unconfirmed` in open questions.
4. `_work` state is updated only after docs are flushed.

If interrupted before `_work` is updated, repeat or reconcile that micro-batch later. Duplicate work is acceptable. Losing understanding is not.

## Rolling Parent Docs

Do not wait for an entire directory to be complete before writing a parent module doc. Parent docs should be useful while partial, but rolling updates must not turn unit/module/thread/overview layers into duplicate decision logs.

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
