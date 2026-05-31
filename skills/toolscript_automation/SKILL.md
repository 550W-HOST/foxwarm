---
name: toolscript_automation
description: Use ToolScript when you want one script to orchestrate multiple tool calls, capture structured results, and optionally pause for agent input.
---

# toolscript_automation

Use this skill when a task is better expressed as a **small script that drives tools** instead of a normal one-shot tool loop.

## Fast start

Before grepping tests, read:

- `examples/toolscript/automation_basic.py`
- `examples/toolscript/README.md`

## When to use ToolScript

Prefer ToolScript when:

- you already know the main tools you want to call
- you expect the same flow to be reused
- the flow needs several tool calls with some local logic between them
- you want `print(...)` output and a final structured result
- you want to pause at `ask_agent(...)` and resume later with `continue_script(...)`
- you want to run the same script in foreground now or background later with the same run model

Typical fit:

- repeatable tool sequences
- multi-step automation with light branching
- a task where you want a reusable script file, not only a one-time answer
- situations where you want tool calls to happen **inside ToolScript** without polluting the outer session history with nested tool-call chatter

Prefer a normal tool loop when:

- the task is short and one-off
- there is no benefit in saving a script file
- simple direct reasoning plus one or two tool calls is enough

## Recommended workflow

In practice, a good default flow is:

1. use normal tool calls in the agent loop to explore/verify the tool path
2. once you know the tools and argument shapes you want, write the ToolScript file with an explicit `def main(args): ...` entrypoint
3. if the task is close to the canonical example, copy/adapt it instead of starting from a blank file
4. run the script with `run_script(...)` or `start_toolscript_run(...)`
5. inspect the structured run result and resume with `continue_script(...)` if needed

ToolScript scripts should now use an explicit entrypoint:

```python
def main(args):
    ...
    return {...}
```

Do not rely on the last expression in the file becoming the result.

## Main tool entry points

Current ToolScript run tools:

- `run_script({filePath, args?, mode?})`
  - starts a ToolScript run
  - default mode is `foreground`
  - default timeout budget is `30s` per run/continue slice unless you pass `timeoutSecs`
- `start_toolscript_run({filePath, args?, mode?})`
  - clearer background-oriented entry point
  - defaults to `background`
- `continue_script({runId, continuationId, input})`
  - resumes a run that is waiting for `ask_agent(...)`
  - also resumes a run paused at `waitingReason="timeout"`
- `list_toolscript_runs({limit?, status?})`
- `get_toolscript_run({runId})`
- `cancel_toolscript_run({runId})`

All of these return **structured run data**, not only plain text.

## Canonical example

If your task is close to the basic automation pattern, copy/adapt `automation_basic.py` first.

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

The main shape is the same unified descriptor style used by the normal model-facing `call_tool` tool.

Examples:

```python
def main(args):
    files = call_tool({
        "toolId": "builtin:list_files",
        "args": {
            "dirPath": "examples/toolscript",
            "recursive": False,
            "includeHidden": False,
            "limit": 20,
        },
    })

    content = call_tool({
        "toolId": "builtin:read",
        "args": {"filePath": "README.md"},
    })

    repos = call_tool({
        "source": "mcp",
        "server": "github",
        "name": "search_repos",
        "args": {"query": "foxwarm"},
    })

    remote_result = call_tool({
        "source": "node",
        "nodeId": "some-node",
        "name": "android_screenshot",
        "args": {"inline": True},
    })

    return {
        "fileCount": files.get("count", 0),
        "contentPreview": content[:80],
        "repos": repos,
        "remoteResult": remote_result,
    }
```

Notes:

- the wrapper accepts either a tool name + args, or a fuller descriptor
- the unified descriptor object is the preferred mental model
- builtin / MCP / node tools all go through the same bridge to the existing unified `call_tool` wrapper
- normal session / node / isolation permissions still apply through that bridge
- nested internal tool calls are executed for real
- those nested calls do **not** spam the outer session history the way ordinary model tool loops do
- `call_tool(...)` works best once you already know the tools and argument shapes you want in the scripted flow
- the string shorthand still works for simple builtin cases, for example `call_tool("read", {"filePath": "README.md"})`

### `ask_agent(...)`

Use this when the script should stop and wait for agent input.

Example:

```python
def main(args):
    decision = ask_agent("Continue with deployment draft? Reply yes or no.")
    print(f"decision={decision}")
    return {"decision": decision}
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
def main(args):
    summary = request_model_without_context("Summarize this in one sentence: ...")
    print(summary["text"])
    return summary
```

To force a specific model for that helper call, pass `model`:

```python
summary = request_model_without_context(
    "Summarize this in one sentence: ...",
    model="openai/gpt-4.1-mini",
)
```

Notes:

- this does **not** create a fake chat session
- it uses the low-level provider request path directly
- if `model` is omitted, it uses the owner session's current model
- tools are not exposed inside that helper call

## Minimal example script

```python
def main(args):
    print("starting automation")

    files = call_tool({
        "toolId": "builtin:list_files",
        "args": {
            "dirPath": "examples/toolscript",
            "recursive": False,
            "includeHidden": False,
            "limit": 20,
        },
    })
    print(files)

    doc = call_tool({
        "toolId": "builtin:read",
        "args": {"filePath": "README.md"},
    })
    print(doc[:200])

    label = ask_agent("Give this run a short label")

    return {
        "label": label,
        "exampleFileCount": files.get("count", 0),
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
  - if `waitingReason="timeout"`, the run paused at a safe checkpoint and the result should tell you that `continue_script(...)` can keep executing it

## Common Tool Return Shapes

When you `call_tool(...)` inside ToolScript, the return value is the **direct result** from the tool implementation (normalized to Python-native types). Here are the shapes for the most commonly used builtin tools:

### `call_tool("read", {"filePath": "..."})`

- **File (text):** returns a **string** — the file content (or the requested line range).
- **Directory:** returns a **string** — a formatted listing like:
  ```
  Directory listing for `src/`

  1. `config.ts` (file, 1234 B) - 2026-05-01T12:00:00.000Z
  2. `utils/` (dir) - 2026-05-01T12:00:00.000Z

  Showing items 1-2 of 2.
  ```
- **Image file** (`.png`, `.jpg`, etc.): returns a **dict** with keys `output`, `mimeType`, `sizeBytes`, `inlineData`.

Typical usage:

```python
content = call_tool("read", {"filePath": "src/main.ts"})
# content is a string
lines = content.split("\n")
```

### `call_tool("exec", {"command": "...", "cwd": "...", "timeout": 15})`

Returns a **string**. The shape depends on whether the command finishes within the timeout:

- **Completed:** the raw stdout+stderr output as a string. If the working directory changed, a notice line is prepended:
  ```
  Working directory changed to `/some/path` (session cwd updated).

  <actual command output>
  ```
- **Truncated output** (>10k tokens): wrapped with `[OUTPUT TOO LONG]` markers at start/end, middle replaced with `[...TRUNCATED...]`, and a path to the full log file at the end.
- **Background timeout:** starts with `[Process running longer than Ns]`, includes partial output, then a footer with PID and log file path.

Typical usage:

```python
output = call_tool("exec", {"command": "git status", "cwd": "/home/user/repo"})
# output is a string; parse it as needed
if "nothing to commit" in output:
    print("clean")
```

### `call_tool("write", {"filePath": "...", "content": "...", "overwrite": True})`

Returns the **string** `"File written successfully"` on success.

Throws an error if the file already exists and `overwrite` is not `True`.

```python
result = call_tool("write", {"filePath": "output.txt", "content": "hello", "overwrite": True})
# result == "File written successfully"
```

### `call_tool("edit", {"filePath": "...", "oldText": "...", "newText": "..."})`

Returns the **string** `"File edited successfully"` on success.

Throws if `oldText` is not found or matches multiple locations.

```python
result = call_tool("edit", {
    "filePath": "src/config.ts",
    "oldText": "port: 3000",
    "newText": "port: 8080",
})
# result == "File edited successfully"
```

### `call_tool("apply_patch", {"input": "..."})`

Returns a **string** summarizing the operations:

```
Patch applied successfully.
- Updated src/foo.ts
- Added src/bar.ts
- Deleted old/baz.ts
```

### `call_tool("search_tools", {"query": "...", "sources": ["builtin"], "limit": 5})`

Returns a **dict**:

```python
{
    "count": 3,           # number of results returned (capped by limit)
    "totalMatched": 12,   # total matches before limit
    "tools": [
        {
            "source": "builtin",
            "toolId": "builtin:read",
            "name": "read",
            "description": "Read a file or list a directory...",
            "inputSchema": {...},       # present for first 10 results
            "directExposed": True,
            "hidden": False,
        },
        ...
    ],
    "warnings": [...]     # only present if there were errors
}
```

### `call_tool("search_vector", {"query": "...", "limit": 5})`

Returns a **dict** with search results from vector memory.

### `request_model_without_context(prompt)`

Returns a **dict** with a single key:

```python
result = request_model_without_context("Summarize: ...")
# result == {"text": "The summary is..."}
text = result["text"]
```

You can also pass a `model` keyword argument:

```python
result = request_model_without_context("Summarize: ...", model="openai/gpt-4.1-mini")
```

## Known Limitations / Gotchas

### No `os.path` module

ToolScript runs on [Monty](https://github.com/pydantic/monty) (a Python-subset interpreter in JS). While `import os` works for some things (e.g., `os.getcwd()`), **`os.path` is not available**:

```python
import os
os.path.join("a", "b")  # ❌ AttributeError: 'module' object has no attribute 'path'
```

Workaround: use string concatenation or f-strings for paths, or call `exec` with shell commands.

```python
path = f"{base_dir}/{filename}"
```

### Available stdlib modules

These work: `json`, `re`, `math`, `os` (partial — no `os.path`).

These do **not** work: `os.path`, `pathlib`, `subprocess`, `sys`, `typing` (at runtime), `collections`, `datetime`, and most other stdlib modules. If you need filesystem operations, use `call_tool("exec", ...)` or `call_tool("read", ...)`.

### Helper functions must be defined before `main()`

```python
# ✅ Correct
def helper(x):
    return x * 2

def main(args):
    return helper(3)
```

```python
# ❌ Wrong — helper not yet defined when main runs
def main(args):
    return helper(3)

def helper(x):
    return x * 2
```

### `def main(args):` is required

Every ToolScript must define `def main(args):` as its entrypoint. The script cannot rely on top-level expressions for the result.

### Return value must be explicit

`main()` must explicitly `return` a value. If you forget the return statement, the run result will be `None`/`null`.

### `print()` goes to `stdout` in the run result

`print(...)` output accumulates in the run's `stdout` field. It does not appear in the outer session. Use it for debugging/logging within the script.

### No `import` of local files

You cannot import other `.py` files. Each script is self-contained. If you need shared logic, define it as helper functions within the same script file.

### Error handling

If `call_tool(...)` throws (e.g., file not found, permission denied), the entire script fails unless you catch it:

```python
def main(args):
    try:
        content = call_tool("read", {"filePath": "maybe-missing.txt"})
    except Exception as e:
        content = None
        print(f"read failed: {e}")
    return {"content": content}
```

### Script resource limits

- **Timeout:** 30s per run/continue slice by default (configurable via `timeoutSecs`)
- **Memory:** 64 MB
- **Max allocations:** 200,000
- **Max recursion depth:** 200

If the timeout is hit at a safe checkpoint, the run pauses with `waitingReason="timeout"` and can be resumed with `continue_script(...)`.

## Current limitations / cautions

- there is **no `ask_user(...)`** host API yet
- background runs exist, but not every waiting mode has full autonomous recovery paths yet
- ToolScript is powerful enough to automate mistakes quickly; still reason about side effects before running scripts
- script files are real workspace files; inspect them like normal source
- if you only need a one-shot answer, writing a script may be overkill
