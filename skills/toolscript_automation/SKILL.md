---
name: toolscript_automation
description: Use ToolScript when you want one script to orchestrate multiple tool calls, capture structured results, and optionally pause for agent input.
---

# toolscript_automation

Use this skill when a task is better expressed as a **small script that drives tools** instead of a normal one-shot tool loop.

Typical fit:

- repeatable tool sequences
- multi-step automation with light branching
- a task where you want a reusable script file, not only a one-time answer
- situations where you want tool calls to happen **inside ToolScript** without polluting the outer session history with nested tool-call chatter

## When ToolScript is a good choice

Prefer ToolScript over a normal tool loop when:

- you expect the same flow to be reused
- the flow needs several tool calls with some local logic between them
- you want `print(...)` output and a final structured result
- you want to pause at `ask_agent(...)` and resume later with `continue_script(...)`
- you want to run the same script in foreground now or background later with the same run model

Prefer a normal tool loop when:

- the task is short and one-off
- there is no benefit in saving a script file
- simple direct reasoning plus one or two tool calls is enough

## Main tool entry points

Current ToolScript run tools:

- `run_script({filePath, args?, mode?})`
  - starts a ToolScript run
  - default mode is `foreground`
- `start_toolscript_run({filePath, args?, mode?})`
  - clearer background-oriented entry point
  - defaults to `background`
- `continue_script({runId, continuationId, input})`
  - resumes a run that is waiting for `ask_agent(...)`
- `list_toolscript_runs({limit?, status?})`
- `get_toolscript_run({runId})`
- `cancel_toolscript_run({runId})`

All of these return **structured run data**, not only plain text.

Important result fields commonly include:

- `runId`
- `mode`
- `status`
- `stdout`
- `executedTools`
- `waitingReason`
- `waitingFor`
- `result`
- `error`

## Host functions available inside ToolScript

Inside the script, you can currently use:

- `print(...)`
- `call_tool(...)`
- `ask_agent(...)`
- `request_model_without_context(...)`

### `call_tool(...)`

Use this to call builtin/MCP/node tools from the script.

Examples:

```python
tools = call_tool("search_tools", {
    "query": "read file",
    "sources": ["builtin"],
    "limit": 3,
    "includeSchema": False,
})

content = call_tool("read", {"filePath": "README.md"})
```

Notes:

- the wrapper accepts either a tool name + args, or a fuller descriptor
- nested internal tool calls are executed for real
- those nested calls do **not** spam the outer session history the way ordinary model tool loops do

### `ask_agent(...)`

Use this when the script should stop and wait for agent input.

Example:

```python
decision = ask_agent("Continue with deployment draft? Reply yes or no.")
print(f"decision={decision}")
```

When the run pauses:

- run status becomes `waiting`
- `waitingReason` becomes `agent`
- the tool result includes `continuationId` and `question`

Resume with:

```text
continue_script({runId, continuationId, input})
```

### `request_model_without_context(...)`

Use this for a low-context helper model call when you want a small local transformation or suggestion without dragging in the full outer session context.

Example:

```python
summary = request_model_without_context("Summarize this in one sentence: ...")
print(summary["text"])
```

Notes:

- this does **not** create a fake chat session
- it uses the low-level provider request path directly
- tools are not exposed inside that helper call

## Minimal example script

```python
print("starting automation")

tool_search = call_tool("search_tools", {
    "query": "read file",
    "sources": ["builtin"],
    "limit": 1,
    "includeSchema": False,
})
print(tool_search)

doc = call_tool("read", {"filePath": "skills/toolscript_automation/SKILL.md"})
print(doc[:200])

label = ask_agent("Give this run a short label")

{
    "label": label,
    "found": tool_search,
}
```

## How to interpret ToolScript run results

After `run_script(...)` or `start_toolscript_run(...)`, inspect:

- `status`
  - `completed`, `waiting`, `failed`, `cancelled`
- `stdout`
  - accumulated `print(...)` output
- `executedTools`
  - summary list of inner tool names used by the script
- `result`
  - final returned value if completed
- `waitingReason` / `waitingFor`
  - why the run stopped and what it needs next

## Current limitations / cautions

- there is **no `ask_user(...)`** host API yet
- background runs exist, but not every waiting mode has full autonomous recovery paths yet
- ToolScript is powerful enough to automate mistakes quickly; still reason about side effects before running scripts
- script files are real workspace files; inspect them like normal source
- if you only need a one-shot answer, writing a script may be overkill

## Good agent workflow

When asked to automate a task with ToolScript, a strong pattern is:

1. inspect/load this skill
2. draft the script file
3. briefly sanity-check the script
4. run it with `run_script(...)` or `start_toolscript_run(...)`
5. inspect the structured run result
6. if it is waiting for agent input, resume with `continue_script(...)`
