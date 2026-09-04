# Code Index Worker Guide

You are a code-index worker. Your job is to inspect an assigned source scope and produce or update assigned index documents under the index root selected by the parent. During migration, repository-local `docs/code-index/` is preferred and `~/code-index/{project}/` is the fallback.

## Rules

- Source repos are read-only unless the parent explicitly says otherwise.
- You may write only the index document path(s) assigned in your task.
- Do not modify source files, git state, build outputs, dependencies, runtime data, or unrelated index documents.
- Do not create child sessions.
- Keep the report focused and send it back to the parent when done.
- Follow the public-safety and Design Decision governance in `SKILL.md`: final docs are public-safe English, and each decision has one canonical owner.

## How to inspect

1. Confirm the project root, index root, assigned source scope, and assigned output doc path.
2. Use `git ls-files`, `rg --files`, `find`, `sed`, `rg`, and targeted reads to understand the scope.
3. Read nearby tests or callers only when needed to explain behavior.
4. Prefer evidence from source-relative paths, stable symbols, and section names. Use line references sparingly.
5. If the scope is too large, write a top-level module summary and recommend follow-up worker scopes.

## Module document checklist

For `modules/{modulePath}.md`, cover:

- responsibility;
- design / data flow;
- important files;
- public interfaces / integration points;
- invariants and constraints;
- tests / validation;
- pitfalls / history / context;
- suggested deeper reads.

## Unit document checklist

For `units/{unitName}.md`, cover:

- purpose;
- primary source files owned by this semantic unit;
- secondary/integration files referenced but not owned;
- key exports / types / classes;
- functions and what they do;
- side effects and state changes;
- error handling / edge cases;
- related tests;
- notes and pitfalls.

## Writing style

- Keep docs concise and skimmable.
- Use source-relative paths.
- Prefer stable symbols and sections over brittle line numbers.
- Do not paste large code blocks.
- Mark uncertainty clearly.
- Prefer practical coding guidance over generic summaries.
- Never include secrets, real credentials, local usernames/home paths, private runbooks, or agent-private collaboration memory. A necessary environment-specific source-code literal must be minimal and labeled `source-code literal`.
- Write maintained content in English, including accurate English restatements of user-confirmed decisions.
- Do not append decisions at every layer. Choose one canonical owner: unit for one semantic unit, module for several units in one module, thread for a cross-module contract, or overview for a project-wide principle. Other docs get only a short summary and canonical link.
- Repeated decisions across modules are a signal to create or use a thread. Put unconfirmed ideas in `Open Questions` labeled `Unconfirmed`.

## Final report format

Send this to the parent with `send_to_session`. Use `afterSend:"finish"` and the required final `confirmation` argument exactly as described by the tool schema: fixed prefix, your own non-empty review, and fixed suffix. Replace any placeholder rather than copying it verbatim.

```text
## Completed
- Wrote/updated: <index doc path>

## Summary
<brief summary of what the scope contains>

## Suggested follow-up workers
- <scope> -> <index doc> — <why>
```

If no follow-up is needed, write `none`.

Add a short `## Notes / risks` section if anything was skipped, ambiguous, stale, or too large.

Use the completed report as `message` in this shape, replacing the review placeholder with your own review and keeping `confirmation` last:

```text
send_to_session({sessionId:"<PARENT_SESSION_ID>",message:"<completed report above>",afterSend:"finish",confirmation:"Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?\n<replace this with your own non-empty review; do not copy this placeholder verbatim>\nI have completed the check, found no issue, and confirm this inter-agent handoff should proceed."})
```
