# Collaboration Patterns for Agents and Sessions

Read this before initializing memory for an agent that will create child sessions, coordinate parallel work, or inherit shared collaboration rules.

This document is guidance for agent builders. It is intentionally general: do not copy private paths, account details, deployment secrets, or one-off project history into public/shared agent memory.

## Core mental model

Foxwarm separates **agents** from **sessions**:

- **Agent**: long-lived identity, memory, workspace, inherited rules, and optional isolation binding.
- **Session**: one conversation/runtime thread under an agent.

The same agent memory is visible to both main/direct sessions and child sessions. Therefore, memory should not say "I am always the parent" or "I am always the child". It should teach the session how to infer its current role.

Recommended role detection:

- If the current system message says this is a child session, or provides a parent session id and a required `reply_via`, act as an **Executor**.
- If the session is handling direct user work and is not marked as a child, act as an **Organizer** by default.
- Use the current system-provided session id, parent id, `source_session_id`, and `reply_via`; do not hard-code a particular session id.

## Recommended default: Organizer / Executor

Use **Organizer / Executor** as the default collaboration pattern.

The Organizer is usually the main/direct session. It owns planning, coordination, user-facing judgment, and final decisions.

Executors are usually child sessions. They own bounded investigation, implementation, testing, or review work inside explicit constraints.

### Organizer responsibilities

- Understand the user's request and identify ambiguity before delegating.
- Decide what can run in parallel, what must run serially, and what depends on earlier results.
- Assign ownership of mutable resources: files, directories, branches, worktrees, services, nodes, test targets, and deployment targets.
- Choose whether to fork, create a clean non-fork child, or reuse an existing child session.
- Give each Executor a clear scope, constraints, validation expectations, stop conditions, and report format.
- Preserve global judgment instead of blindly following child reports.
- Summarize child reports to the user at the right level of detail.

### Executor responsibilities

- Stay within the assigned scope.
- Inspect and understand before editing.
- Do not touch unassigned mutable resources.
- Report uncertainty, blockers, and scope creep instead of silently expanding the task.
- Validate work when practical and say exactly what was or was not tested.
- Report completed facts, engineering judgment, validation results, artifacts or commits, remaining risks, and next recommendations.
- Send final handoff through the required reply path.

## Variants within Organizer / Executor

### Read-only research swarm

A research swarm is not a separate top-level mode. It is Organizer / Executor with multiple read-only Executors.

Use it when several hypotheses, designs, or code areas can be investigated independently.

Good defaults:

- The Organizer assigns each child a distinct question or code area.
- Children are read-only unless explicitly authorized to write.
- Children should not run conflicting services or mutate shared environments.
- The Organizer compares findings and chooses the next direction.

### Implementer / Reviewer split

Use this when a task is risky enough to benefit from a second independent pass.

Typical shape:

- one Executor implements or prepares a patch;
- another Executor reviews, tests, or performs adversarial checks;
- the Organizer owns the final decision.

Avoid letting both sessions edit the same files or service unless the Organizer explicitly coordinates the handoff.

### Avoid over-fragmented pipelines

Pipeline-style handoff such as "A investigates, B implements, C tests" is often fragile because context transfer is hard. Prefer one Executor carrying a coherent vertical slice when possible.

If a pipeline is unavoidable, the Organizer should restate the current state, rationale, constraints, and expected output at each stage. Do not forward only "continue" or "do the next step".

## Choosing fork, non-fork, or reuse

### Use fork when

- the child needs the current conversation context;
- the work is a short branch of the current discussion;
- restating all background would be wasteful;
- sharing the current prompt prefix is desirable.

Caveat: fork only copies context at creation time. Any later user or parent discussion that changes goals, constraints, interpretation, motivation, or success criteria must be sent to the child as an explicit delta.

### Use non-fork when

- the task is independent;
- the old context may be noisy, private, or misleading;
- you want the child to receive a clean, explicit handoff;
- an older child session is stale and the new task is not clearly the same continuing task.

For non-fork children, include enough background for the child to succeed without reading the parent conversation.

### Reuse an existing child when

- it recently investigated the same subsystem or problem;
- it already owns the relevant workspace, branch, service, or test environment;
- continuing it avoids repeated setup and context loading.

Avoid reusing an old child merely because it once touched the same topic. If old context may help, a new child can inspect the old session or docs explicitly.

## Coordination plan before delegation

Before creating or messaging child sessions, the Organizer should decide:

- what can run in parallel;
- what must be serial;
- what depends on earlier results;
- which session owns each mutable workspace, branch, file set, service, node, test target, or deployment target;
- what each child is forbidden to touch;
- whether the child may edit, run tests, commit, push, restart services, or deploy;
- what validation is expected;
- when the child should stop and report.

Default safety rule: only one session should own a mutable environment at a time. If overlap is intended, say so explicitly.

## Handoff checklist

For a new non-fork child, include:

- the user's request or a faithful excerpt when wording matters;
- the Organizer's interpretation;
- the task goal;
- assigned scope;
- out-of-scope items;
- workspace, branch, service, node, and test ownership;
- read/write permissions;
- validation expectations;
- stop conditions;
- expected report format.

For a forked child or an existing child that already shares context, send only the useful delta:

- new constraint;
- changed decision;
- changed success criteria;
- new ownership boundary;
- current next action.

Do not send vague references like "the previous option" or "that plan above" unless you restate what they mean.

## Report format

Executor reports are easiest to use when they separate:

- completed facts;
- judgment or interpretation;
- validation performed;
- artifacts, files, branches, commits, or other outputs;
- blockers and risks;
- recommended next steps.

Do not say "I continued" or "I started the next stage" unless a follow-up session was actually created, a message was actually sent, or tool work actually began.

## User-facing acknowledgements and waiting

When a direct user is waiting and the Organizer delegates work, usually send a brief acknowledgement and next-step summary. Do not silently wait after a direct user request unless there is truly nothing useful to say.

For inter-session traffic:

- avoid pure confirmation messages with no new information or action;
- child sessions should report completion through the required reply path;
- if the final action is a handoff, send the handoff and then wait;
- if no parent reply is needed and no action remains, use the session's configured no-action convention if one was provided.

## Session goals

Use a session goal only for long-running objectives that may span many turns or compaction boundaries.

Good goal contents:

- final objective;
- stable constraints;
- user-approved boundaries;
- anti-drift direction.

Do not put these in a session goal:

- stage progress;
- latest numbers;
- temporary TODOs;
- short-lived implementation steps;
- details that belong in a child report or project doc.

Clear or update the goal when the objective is complete or materially changes.

## Specialist agents and inherited collaboration rules

Specialist agents are a multi-agent organization pattern, not a replacement for Organizer / Executor inside one agent.

Recommended setup:

1. Create a shared/base agent containing generic collaboration rules:
   - Organizer / Executor;
   - role detection;
   - handoff checklist;
   - memory hygiene;
   - safety and confirmation defaults.
2. Create specialized agents that inherit from the base, such as:
   - development agent;
   - research agent;
   - operations agent;
   - writing agent;
   - project-specific agent.
3. Put only domain-specific durable memory in each specialized agent.
4. Refresh existing session snapshots after changing inheritance or memory if the open sessions should use the new rules immediately.

This avoids copying the same collaboration rules into every agent and keeps specialist memory focused.

## Tunable preferences for agent builders

When initializing an agent, choose defaults for these preferences.

### Delegation autonomy

- **Propose-first**: child sessions investigate and propose; writes require confirmation.
- **Autonomous within scope**: child sessions may edit/test/commit inside assigned boundaries.
- **High autonomy**: child sessions may also push or operate test environments when the memory explicitly allows it.

### Parallelism

- **Serial**: one Executor at a time.
- **Limited parallel**: multiple Executors only with non-overlapping files/worktrees/services.
- **Read-only swarm**: many Executors can investigate in parallel, but do not write.

### Fork preference

- Prefer fork for context continuity.
- Prefer non-fork for clean isolation and explicit handoffs.
- Reuse recent owner sessions when they still own the relevant workspace or service.

### Workspace safety

- Shared checkout allowed for low-risk, non-parallel edits.
- Dedicated worktree required for parallel writes.
- Production/live deployment targets require explicit confirmation.

### Reporting verbosity

- Brief summary if the user can inspect raw child reports directly.
- Structured report for engineering work.
- Fuller summary when the user cannot easily inspect the child session.

### Memory strictness

- Minimal memory: only stable rules and preferences.
- Project memory: add current project paths, commands, and durable conventions.
- Research memory: add durable hypotheses/findings and pointers to detailed notes.

## Memory hygiene

Agent memory is not a progress log.

Long session history is already preserved by layered context, compaction summaries, archives, and `recall`. Therefore, memory should contain only information that should affect future behavior by default.

Use progressive disclosure when deciding where knowledge belongs:

- **Memory**: always-needed stable behavior, repeated preferences, durable environment facts, confirmed decisions, and short pointers.
- **Agent docs**: detailed analysis, runbooks, historical notes, long design writeups, and artifacts that should be available but not injected by default.
- **Skills**: reusable procedures/capabilities whose catalog entry is enough until the task needs full instructions.
- **Skill resources**: detailed references, scripts, assets, examples, and evals that are read only after a loaded `SKILL.md` points to them or the task needs them.

If a directory contains `SKILL.md`, treat it as a skill boundary. Nested files and subdirectories are resources of that skill, not more default memory.

Keep in memory:

- stable role and workflow rules;
- user preferences that should apply repeatedly;
- durable environment facts;
- current long-lived branches or workspaces;
- confirmed design decisions;
- pointers to important docs.

Do not keep in memory:

- secrets, tokens, private keys, or credentials;
- one-off task progress;
- completed-task changelogs;
- detailed experiment logs;
- large pasted reports;
- private personal information in shared/inherited agents.

Rule of thumb: if `MEMORY.md` grows past about **500 lines**, split it. Move reusable procedures into skills. Move knowledge, artifacts, and historical notes into `agent-dir/docs/`. Keep memory as a compact index of always-needed rules and links.

## Memory templates

Starter memory templates live under:

```text
references/memory-templates/
```

Copy the closest template into the target agent's memory directory, then edit it for the actual agent. The template files are written as target memory files, not as explanatory prose.

Suggested use:

- `shared-collaboration-base.md` — copy to a shared/base agent's `MEMORY.md`.
- `specialized-project.md` — copy to a project or development agent's `MEMORY.md`.
- `research.md` — copy to a research agent's `MEMORY.md`.
- `operations.md` — copy to an operations/maintenance agent's `MEMORY.md`.

The templates focus on `MEMORY.md`. If an agent also needs a `USER.md`, keep it separate and minimal: repeated communication/confirmation preferences only, no secrets or sensitive personal details, and do not put user-specific files in shared/inherited agents.
