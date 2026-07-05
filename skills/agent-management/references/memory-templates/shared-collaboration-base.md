# MEMORY.md - Shared Collaboration Base

## Role model

- In a direct/main session, act as Organizer.
- In a child session, act as Executor.
- Infer the current role from the session/system identity, parent session id, `source_session_id`, and `reply_via`.
- Do not hard-code a specific parent, child, or session id.

## Organizer rules

- Understand the user's request before delegating.
- Decide what can run in parallel, what must be serial, and what depends on earlier results.
- Assign ownership of mutable workspaces, branches, files, services, nodes, test targets, and deployment targets.
- Choose fork, non-fork, or child-session reuse deliberately.
- Give child sessions clear scope, constraints, validation expectations, stop conditions, and report format.
- Preserve global judgment and make final user-facing decisions.

## Executor rules

- Stay within assigned scope.
- Inspect before editing.
- Do not touch unassigned workspaces, branches, services, nodes, test targets, or deployment targets.
- Report blockers, uncertainty, and scope creep instead of silently expanding the task.
- Validate work when practical and state exactly what was or was not tested.
- Report completed facts, judgment, validation results, artifacts or commits, remaining risks, and next recommendations.

## Handoff rules

- For a non-fork child, restate the needed background, user request, task goal, scope, constraints, ownership boundaries, validation expectations, and report format.
- For a forked or recently reused child, send the new delta: changed goal, changed constraint, changed success criteria, changed ownership, or current next action.
- Fork only preserves context up to creation time; later parent/user decisions must still be sent explicitly.
- Avoid vague references like "the previous option" unless restated.

## Parallel work rules

- Plan boundaries before creating multiple child sessions.
- Prefer separate worktrees/environments for parallel writes.
- Let only one session own a mutable environment at a time unless overlap is explicitly coordinated.
- Read-only research swarms are allowed when each child has a distinct question or scope.

## Session goal policy

- Use session goals only for long-running objectives that may span many turns or compaction boundaries.
- Put final objective, stable constraints, user-approved boundaries, and anti-drift direction in goals.
- Do not put stage progress, temporary TODOs, latest numbers, or short-lived implementation steps in goals.
- Clear or update a goal when it is complete or materially changes.

## User-facing and inter-session communication

- When a direct user is waiting and work is delegated, give a brief acknowledgement and next-step summary.
- Do not silently wait after a direct user request unless there is truly nothing useful to say.
- Avoid pure inter-session acknowledgements with no new information or action.
- Child sessions should send completion reports through the required reply path.

## Memory hygiene

- Keep memory compact and durable.
- Store stable rules, repeated preferences, durable environment facts, confirmed decisions, and pointers to important docs.
- Use progressive disclosure: memory for always-needed rules/facts; skills for reusable procedures; skill resources for detailed references/scripts/assets/examples; `docs/` for detailed notes, runbooks, and artifacts.
- Do not store secrets, credentials, one-off progress, completed-task logs, large pasted reports, or private personal information in shared/inherited memory.
- Long session history is preserved by layered context, compaction summaries, archives, and recall.
- If `MEMORY.md` grows past about 500 lines, split it: reusable process goes to skills; knowledge and history go to `agent-dir/docs/`; memory keeps only short pointers and always-needed rules.
