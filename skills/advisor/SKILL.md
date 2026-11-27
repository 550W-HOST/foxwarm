---
name: advisor
description: Get advice from a stronger model on a decision you face. The advisor sees this Session's full context, investigates without changing anything and reports back.
run:
  entry: scripts/consult.py
  effect: Forks this Session to the advisor model, which investigates without changing anything and sends its advice back; this turn ends and resumes when the advice arrives.
  args:
    type: object
    additionalProperties: false
    required: [question]
    properties:
      question:
        type: string
        description: The decision you face, the options you considered, what you tried and what kind of answer you need.
      model:
        type: string
        description: Configured model key for the advisor. Defaults to the key named advisor.
      effort:
        type: string
        enum: [none, low, medium, high, xhigh, max]
        description: Effort for the advisor. Defaults to the advisor model's own default.
      waitSeconds:
        type: integer
        description: Seconds after which this Session wakes if no advice has arrived. Defaults to 3600.
---

# Advisor

Run it directly with `ctl skill run advisor --args @args`, passing the arguments as `values.args`, for example `{"question": "..."}`. There is nothing to load first.

The advisor is a fork of this Session on the advisor model, normally a stronger one than yours. It sees everything you see up to the moment you ask, investigates with read-only actions and sends its advice to you. Your turn ends when you run the skill and resumes when the advice arrives, or after `waitSeconds` if none does; then check the advisor with `ctl session view <advisor>`.

## When to consult

- A consequential decision: architecture, an approach that is costly to reverse, or a trade-off you can't settle from the evidence.
- You are stuck after real attempts: say what you tried and how it failed.
- Before an irreversible or wide-reaching step, such as a migration, a deletion or a change many callers depend on.

Not for routine steps you can verify yourself. A consultation with another model rereads your whole context at the advisor's price, often as much as many turns of your own.

## Writing the question

The advisor already has your context, so don't restate it. Say:

- the decision, in one or two sentences;
- the options you considered and what you know about each;
- what you tried, if you are stuck;
- what kind of answer you need: a choice between options, a review of a plan, a diagnosis, or risks you may have missed.

## After the advice

You stay responsible for the decision. Weigh the advice against what you know, verify its claims where it matters, and say in your own report when you followed or rejected it.

- To clarify the same decision, send the advisor a follow-up with `send_to_session` and say what changed. It keeps its earlier investigation.
- For a new decision, or the same one after substantial further work, run a new consultation, so the advisor sees your current context.

The advisor Session is archived, so the Session list shows it dimmed after the others. It stays available: you can send it follow-ups, and the user can open it to read its investigation.

If no model key named `advisor` is configured and you pass no `model`, the skill fails without creating anything. It also refuses when your context is larger than the advisor model's context limit.
