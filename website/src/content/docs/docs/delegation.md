---
title: Delegate work
description: Let an agent hand tasks to child Sessions or other Agents, watch and steer them, and track open work with Tasks.
---

When a task has independent parts, an agent can hand them to other Sessions and keep coordinating from its own. Each delegated part runs in a full Session: it has its own history, survives restarts and appears in the sidebar under the Session that started it. You can open it at any time to see what it is doing, or message it directly.

## Ask for parallel work

You do not need special syntax. Describe the split:

```text
Prepare the v0.5.0 release. In parallel, have one child session audit prorate() for
edge cases and another draft CHANGELOG.md from the git history. Wait for both, then
give me a short summary.
```

The agent creates the child Sessions, gives each a self-contained brief, waits for their reports and summarizes. While it waits it is not polling: the children's reports wake it up.

A child Session can:

- run on a different [Node](/docs/nodes/) from its parent, for example tests on a build server while the parent stays on `master`;
- use a different model or reasoning effort;
- start with a copy of the parent's current context (a *fork*) or with a fresh conversation and only the brief.

Children report back with an ordinary message to their parent. That report appears in the parent's timeline and links to the child.

## Watch and steer

Delegated work is not a black box. In the sidebar, child Sessions are nested under their parent. Open one to see its tool calls and progress in real time.

To change course, send the child a message directly: *"Keep full precision here; invoices round later."* It arrives in the child's queue like any user message and the child adjusts. The parent sees the outcome in the child's report. If the parent should know about your instruction, mention it to the parent as well.

You can also continue a child after it reports, or reuse it for a follow-up in the same area instead of starting a new one.

## Hand work to another Agent

A child Session can belong to a different Agent than its parent. The receiving Agent brings its own memory, Skills, [rules](/docs/access-control/) and default Node. Use this when the work needs a different role or tighter access, for example:

- a `docs` Agent with your style guide in its memory writes customer-facing text;
- a `ci-runner` Agent that may only run commands on `build-box` runs the test suite.

Agents can create these helper Agents themselves. A created Agent's rules can only narrow what its creators allow; see [Agents that create Agents](/docs/agents-sessions-memory/#agents-that-create-agents).

Sessions that are not parent and child can still exchange messages with `send_to_session` when their rules allow it.

## Track open work with Tasks

A **Task** is a shared, lightweight record of something that needs doing: a title, a description, an owner Session and notes. Agents use Tasks to assign work to a child and to keep track of what is still open across Sessions. When a Task is completed, the Session that created it is notified with the result.

Open the **Tasks** panel in the WebUI sidebar to see open and active Tasks and their owners.

## Good habits

- Split work only where parts are really independent. Two Sessions editing the same files or using the same test environment at the same time will get in each other's way.
- Give each child one clear outcome. The agent writes the brief, but you can ask it to show you the plan first.
- Keep the final decision in the parent. Children report evidence; the parent, or you, decide what to do with it.
