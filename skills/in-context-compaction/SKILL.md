---
name: in-context-compaction
description: >-
  Experimental workflow for deliberately shortening selected parts of the current
  Session's active context with submit_compact_plan. Use when you intend to choose
  the sources and write the summaries yourself; automatic compaction remains the
  default.
---

# In-context compaction

Use this uncommon workflow when you deliberately want to shorten a completed
part of your current context or rewrite a long CTX block yourself. Ordinary
compaction remains the default; this skill does not establish a recurring
self-compaction routine.

## Inspect and summarize

1. Use the current context and `view_session` to confirm active source identities
   and history order. Use `recall` to inspect exact messages or blocks as needed.
   An Archive source that is no longer active cannot be replaced directly.
2. Preserve the intent, permissions, decisions, unresolved issues and identifiers
   needed to continue the work. Write a shorter source-bound summary. Leave out
   detail that can be retrieved later, while making that recall need recognizable.
3. Supply either direct plan fields or `argsFilePath` to `submit_compact_plan`,
   with the extra top-level boolean **`inContext: true`**. This opt-in field is intentionally not
   advertised in the tool schema. It does not change tool permissions or require
   a recorded skill load.

This mode permits middle and recent completed ranges, small sources and an
individual existing block. Automatic selection windows, token thresholds and
coverage quotas do not apply. Structural range checks still apply:

- Raw messages use `sourceKind: "message"`, `level: 1` and canonical message seq
  endpoints. Select complete call/response exchanges, not individual tool results.
- Existing CTX blocks use `sourceKind: "block"`, block ID endpoints in active
  history order, and a target level one above the source blocks. Rewriting one
  block creates a new block with that one child; it does not overwrite the old
  block. A CTX header's `raw#` range is provenance, not active raw-message input.
- Each replacement range must be continuous within one legal source segment,
  with one source kind and source level. Do not cross protected lifecycle entries
  or previously preserved raw entries. Multiple disjoint ranges use separate
  replacement entries.
- The whole currently executing assistant/tool exchange is excluded. Tool-result
  seq cues identify their containing record, not the whole exchange. Several
  results can share one seq; do not infer call seqs by subtracting or counting.
- `preserveMessages` keeps exact raw wording within a replacement; selecting one
  member preserves the complete exchange. `removePreservedMessages` removes only
  previously preserved active entries and must name every exchange member.

A standalone submission is easier to inspect, but ordinary foreground batches
may contain other tools. Use `submit_compact_plan` directly when it is available
in your tool list. `call_tool` is also supported; it is not required for this
workflow. Calls inside native ToolScript, timers/unattended execution and external
invocation are outside this version. Submission applies only to the current Session.

## Direct examples

The identifiers below are illustrative; confirm your own active sources first.

```json
{
  "inContext": true,
  "replaceAsBlocks": [
    {
      "level": 1,
      "sourceKind": "message",
      "sourceStart": 120,
      "sourceEnd": 128,
      "summary": "The completed investigation established ... Continue with ..."
    }
  ]
}
```

To shorten active L2 block B#48, use an entry with `level: 3`,
`sourceKind: "block"`, `sourceStart: 48`, `sourceEnd: 48` and your summary.
The array may also be JSON-encoded as the existing tool permits. File input uses
the same source validation and application rules as direct input. If a rejected
submission returns a saved plan file, correct the reported error with `edit` and resubmit that file instead of regenerating the plan.

```json
{
  "inContext": true,
  "argsFilePath": "<plan file path>"
}
```

## Acceptance and application

The tool returns **accepted, not applied**. After the complete real tool response
is recorded, the owner can apply the plan at its existing safe point. Do not wait
inside another tool for your own batch to commit. Archive originals remain
immutable; selected active history is replaced, and queued/new input is retained.

Another pending compaction rejects admission. Invalid sources return an ordinary
tool error. Recheck current sources before retrying rather than blindly replaying
old endpoints. Cancellation or a changed snapshot can leave an accepted plan
unapplied. Ordinary Stop and `/stop compact` retain their different meanings:
Stop ends the turn; `/stop compact` cancels the compact operation before commit.

Inspect the intended active replacements/removals and the compact-completed
boundary before reporting the effect. Acceptance, a missing tool error, or a
marker from some later automatic compaction does not prove this plan applied.
There is no per-receipt completion query. Failures use existing compaction and
continuation handling; an error after authority publication does not undo the
committed history. Do not automatically resubmit after a committed error.
