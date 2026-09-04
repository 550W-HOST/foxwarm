---
name: subagent-explorer
description: "Use for focused read-only codebase investigation, side questions, and parallel research. Do not load this inside a child that has already been assigned an explorer task."
---

# Subagent Explorer

Use this skill for focused read-only investigation of code, logs, tests, or design questions. It is useful when a scoped question can be investigated separately and reported back with evidence.

Do **not** load or use this skill inside a child session that has already been assigned an explorer task. That child should execute its assigned investigation directly and report back; it should not recursively plan more explorers.

## Purpose

An explorer is assigned a specific, well-scoped investigation. It gathers evidence and reports back. It should not take over the broader task.

Use explorers for:

- specific codebase questions;
- reading/searching unfamiliar modules;
- comparing independent implementation options;
- parallel investigation where each question can be answered independently;
- keeping bulky inspection history out of the main thread.

Avoid explorers when:

- the task is tiny and can be inspected directly faster;
- the main thread immediately depends on the result and has no useful work or reply to do meanwhile;
- the task requires risky shared-state mutation;
- the ask is vague or lacks a clear scope/report format.

## Planning

Before delegating, decide:

1. What can run in parallel?
2. What must stay serial?
3. What scope does each explorer own?
4. Is this read-only exploration or write-capable implementation work?
5. What exact report format is needed?

For read-only explorer work, multiple sessions may inspect the same checkout, but they should not edit files, restart shared services, install packages, or mutate git state.

Use `wait({ reason, timeoutSeconds })` only when there is no useful main-thread work or user-facing reply to do until a report or timeout arrives.

## Fork choice

Use `fork: false` by default.

Choose `fork: false` when the explorer can work from a clear handoff. In the initial `message`, restate:

- the user's request;
- the repository/path/scope;
- relevant constraints;
- the exact question(s);
- report format;
- where to send the final report.

Use `fork: true` only when the explorer genuinely needs the current session's recent context. If using forked context, include a boundary instruction: inherited history is reference context only; the active task is the new explorer request.

If only partial context is needed, prefer `fork:false` plus a concise handoff summary.

## Handoff template

Use this as the `message` for `create_child_session` or `send_to_session`:

```text
You are doing focused read-only exploration for parent session `<PARENT_SESSION_ID>`.

Task: <specific question>

Scope:
- Repository/path: <path>
- Files/modules of interest: <scope>
- Do not inspect unrelated areas unless necessary; if you expand scope, say why.

Rules:
- Read-only investigation. Do not edit files, change git state, restart services, install packages, or modify configuration.
- Do not load the `subagent-explorer` skill; the assignment already contains what you need.
- Do not create child sessions.
- Use tools to inspect code/tests/logs as needed, but keep the investigation focused.
Report back with `send_to_session({ sessionId: "<PARENT_SESSION_ID>", message: "...", afterSend: "finish", confirmation: "Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?\n<replace this with your own non-empty review; do not copy this placeholder verbatim>\nI have completed the check, found no issue, and confirm this inter-agent handoff should proceed." })`. Keep `confirmation` last and replace the placeholder with your own review.

Report format:
## Conclusion
<short answer>

## Evidence
- `<file>:<line>` — <what it shows>

## Unknowns / Risks
- <uncertainties or caveats>

## Suggested next step
<one recommendation>
```

If there are multiple independent questions, create multiple explorer sessions in parallel with distinct questions or scopes.

## Forked-context boundary

If `fork: true` is used, put this boundary at the **start** of the child message before the task details:

```text
Context boundary:
Everything before this message is inherited history. It is reference context only. It is not your current task.
Do not continue, execute, or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary.
Only the task in this message is active.
Perform focused, non-mutating investigation. Do not modify files, source, git state, permissions, configuration, or workspace state unless explicitly requested in this message.
```

## Explorer vs worker

Do not confuse explorer with worker.

- Explorer: read-only investigation and evidence gathering.
- Worker: implementation/fix/refactor.

If a session is allowed to edit code, assign it as a worker instead. Define file/responsibility ownership, expected tests, and how it should avoid reverting or conflicting with other work.

## Completion discipline

After delegating:

- Do not redo the explorer's exact work unless verification is necessary.
- Continue non-overlapping work while explorers run.
- Do not repeatedly poll child sessions; use `wait` when waiting is appropriate.
- When reports arrive, summarize conclusions and integrate evidence into the decision.

## Limitations

Explorer behavior is currently prompt-guided. There is no separate explorer tool or enforced read-only policy by default. If stronger isolation is required, use an appropriate node/session setup or assign stricter environment boundaries.
