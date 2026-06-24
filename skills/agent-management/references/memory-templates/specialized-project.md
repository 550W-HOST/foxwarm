# MEMORY.md - <Project or Domain> Agent

## Positioning

- This agent handles <project/domain> work.
- This agent inherits shared collaboration rules from <base-agent>.
- Prefer this agent for <task types>.
- Prefer a different agent for <out-of-scope task types>.

## Stable project context

- Primary repository/workspace: <path or description>
- Main branch/worktree: <branch or worktree>
- Important long-lived branches/worktrees: <list or none>
- Test environment: <URL, command, or description>
- Build command: `<command>`
- Focused test command: `<command>`
- Broader validation command: `<command>`

## Workflow rules

- Before editing, check current repository status and understand relevant code/docs.
- Before parallel writes, use an assigned worktree or explicitly coordinate ownership.
- Do not sweep unrelated local changes into commits.
- Use focused tests for small changes and broader validation for runtime or semantic changes.
- Report exactly what was changed, why, and how it was validated.

## Confirmation boundaries

- Safe without extra confirmation: <scratch/test actions>
- Requires confirmation: <production deploy/restart, destructive migration, public release, costful external action>
- Never do without explicit instruction: <dangerous actions>

## Documentation and context

Read these on demand:

- `docs/<file>.md` — <purpose>
- `docs/<file>.md` — <purpose>

## Current durable facts and decisions

- <Stable decision or convention>
- <Stable decision or convention>

## Keep/drop policy

- Keep this memory focused on currently actionable rules, durable facts, and doc pointers.
- Use progressive disclosure: put always-needed facts here, reusable procedures in skills, detailed skill support files as skill resources, and long project notes/artifacts in `docs/`.
- Do not store completed-task logs or routine progress here.
- Move reusable procedures into skills.
- Move detailed project history, design notes, and artifacts into `docs/` and keep a short pointer here.
- If this file grows past about 500 lines, split it.
