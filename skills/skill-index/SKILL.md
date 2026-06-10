---
name: skill-index
description: "Create, use, and maintain a project code index under ~/code-index/{project} so agents can quickly understand architecture, modules, files, design notes, and project-specific pitfalls while coding."
---

# Skill Index: Project Code Index

A **code index** is a layered, agent-oriented documentation tree stored outside the source repo:

```text
~/code-index/{project}/
├── overview.md          # Top-level architecture, design principles
├── threads/             # Cross-module feature flows (with embedded decisions)
├── modules/             # Module-level summaries (with embedded decisions)
└── units/               # Bottom-level semantic unit summaries
```

## Purpose

Help development agents quickly understand:

- What a project is and how it is structured
- Design constraints and historical decisions relevant to each module
- Cross-module data/control flows
- Where to find relevant code for a given task

The index is a **map**, not the source of truth. Always verify against current source before making risky changes.

## Structure

### `overview.md`

Project-wide architecture overview: module map, core design principles, tech stack, key invariants.

### `modules/{name}.md`

One file per logical module. Contains:

- Responsibility and boundaries
- Internal structure (key files, classes, functions)
- Public interfaces / integration points
- Invariants and constraints
- **Design Decisions** section with dated user decisions relevant to this module

### `threads/{name}.md`

Cross-module feature flows that span multiple modules. Examples:

- `request-lifecycle.md` — input → orchestration → execution → response
- `state-persistence.md` — mutation → storage → reload/recovery
- `tool-execution.md` — schema → dispatch → result formatting
- `streaming-pipeline.md` — provider stream → backend events → client rendering

Contains end-to-end data/control flow descriptions and embedded design decisions.

### `units/{name}.md`

Bottom-level summaries of semantic units (individual files or small file groups). Contains:

- Purpose
- Key exports / types / functions
- Dependencies and callers
- Side effects and state changes

## Granularity Strategy

Units are not 1:1 with files. They are **semantic units**:

- Small files (< 200 lines) are grouped by directory or logical relation
- Large files (> 500 lines) may be split into multiple units by section/class
- Medium files get one unit each

The generation script uses a model call to plan groupings based on file list + sizes.

## Generation

The index is generated using ToolScript (`generate_code_index.py` in this skill directory).

### Phases

1. **Scan & Plan** — list source files, get sizes, call model to plan semantic unit groupings
2. **Units** — for each unit group, read source and call model to generate summary
3. **Modules** — based on unit summaries, call model to generate module-level docs
4. **Threads** — based on module summaries, call model to generate cross-module flow docs
5. **Overview** — based on modules + threads, call model to generate top-level overview
6. **Decisions** — optionally scan an archive database for user decisions and embed them into relevant docs

### Running

```python
# Full generation (all phases)
run_script(filePath="skills/skill-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project"})

# Single phase
run_script(filePath="skills/skill-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project", "phase": "units"})

# Test with specific files only (phase 1-2 on a subset)
run_script(filePath="skills/skill-index/generate_code_index.py", args={"project": "my-project", "source": "/path/to/my-project", "phase": "units", "files": ["src/main.ts", "src/server.ts"]})
```

### Timeout

The script may need multiple `continue_script` calls for large projects since each slice has a 30s default timeout. Use `timeoutSecs: 120` or higher for batch runs.

## Incremental Maintenance

After initial generation, the index is maintained **as part of the development workflow**:

- When modifying code, update the corresponding unit/module/thread docs
- When making design decisions, add them to the relevant module/thread `## Design Decisions` section
- `## Design Decisions` should mainly record user decisions, or elaborations confirmed by the user. Do not write an agent's own unconfirmed idea as a decision; if an unconfirmed judgment must be recorded, clearly mark it as unconfirmed / agent speculation.
- Do not regenerate the full index routinely; use targeted updates

## Using the Index While Coding

1. Read `~/code-index/{project}/overview.md` for orientation
2. Search the index: `rg "<term>" ~/code-index/{project}`
3. Read relevant `modules/` and `threads/` docs
4. Read relevant code-index markdown files **as whole files by default**. Do not use `startLine/endLine` just to read the opening chunk; these docs are meant to stay reasonably small. If a file is genuinely large or you choose not to read it fully, use `rg` to locate the needed section first, especially `## Design Decisions`.
5. Read `units/` docs for file-level detail
6. Verify important details against actual source before editing

## Decision Format

Decisions are embedded in module/thread docs under `## Design Decisions`:

```markdown
## Design Decisions

- [2026-03-15] Background jobs must commit state only at safe points.
- [2026-05-30] Directory listing is handled by the file-read tool.
- [2026-05-27] Streaming events use one unified pipeline.
```
