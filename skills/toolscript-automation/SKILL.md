---
name: toolscript-automation
description: Use ToolScript when you want one script to orchestrate multiple tool calls, capture structured results, and optionally pause for agent input.
---

# ToolScript automation

ToolScript runs a constrained Python-like script that drives Foxwarm tools. Use it for a verified, repeatable tool flow with local branching or data handling. Use the normal agent tool loop for short one-off work or when the tool path is not understood yet.

## Quick start

Read and adapt:

- `examples/toolscript/automation_basic.py`
- `examples/toolscript/README.md`

Every ToolScript defines `main(args)` and returns its result explicitly:

```python
def main(args):
    base_dir = args.get("baseDir", "examples/toolscript").rstrip("/")

    listing = call_tool({
        "toolId": "builtin:read",
        "args": {"filePath": base_dir},
    })
    print(listing[:200])

    label = ask_agent("Reply with a short label")
    return {"label": label, "listingPreview": listing[:200]}
```

Run a file:

```text
run_script({filePath: "examples/toolscript/automation_basic.py", args: {baseDir: "examples/toolscript"}})
```

Or run a small inline script with the `code` argument. The default mode is `foreground`.

## Recommended workflow

1. Discover and test the required tools in the normal agent loop.
2. Confirm their input arguments and return values.
3. Write one self-contained script with an explicit `main(args)` entrypoint.
4. Run it with `run_script(...)`.
5. Inspect `status`, `result`, `error`, and any waiting fields.
6. Resume agent-input or timeout waits with `continue_script(...)`.

## Script contract

- Top-level helpers may be defined before or after `main(args)`; Foxwarm invokes `main` only after the complete source has loaded.
- Define a synchronous `main(args)`. Foxwarm calls it with one object and uses its explicit return value as `result`.
- Keep the script self-contained. Imports of neighboring `.py` files are unavailable.
- `print(...)` writes to the run's captured stdout; it does not emit a normal outer-session message.
- Host-call failures enter the script as runtime exceptions. Catch `Exception` when a failure is recoverable.

```python
def read_optional(path):
    try:
        return call_tool("read", {"filePath": path})
    except Exception as error:
        print(f"read failed: {error}")
        return None


def main(args):
    content = read_optional(args["path"])
    return {"content": content}
```

## Python subset

ToolScript uses Monty rather than CPython. Use ordinary expressions, functions, loops, branching, f-strings, comprehensions, generator expressions, lambdas, `try`/`except`, simple classes, and synchronous `with` statements. Generator expressions currently materialize as lists rather than lazy generators.

Module support is deliberately limited:

- `json`, `re`, `math`, `datetime`, and `unicodedata` support common pure operations.
- `pathlib` supports lexical path manipulation, but it does not grant host filesystem access.
- Type annotations parse, but runtime `typing` objects are only partially supported.
- `asyncio`, `os`, `pathlib`, and `sys` are partial; operations that ask the host for files, environment, working-directory, clock, or process state are rejected.
- Common CPython modules including `shlex`, `collections`, `itertools`, `functools`, `random`, `time`, `subprocess`, and local or third-party modules are unavailable.
- Simple classes work, but inheritance, metaclasses, function/method decorators, and most custom dunder protocols do not.
- `match`, `yield`, `del`, async iteration, and async context managers are unavailable.

Use `call_tool("read", ...)`, `call_tool("write", ...)`, or `call_tool("exec", ...)` for permitted host filesystem and process work. Normal session, node, and isolation permissions apply.

## Script APIs

### `call_tool(...)`

Use one bridge for builtin, MCP, and remote-node tools. The unified descriptor is the clearest form:

```python
def main(args):
    content = call_tool({
        "toolId": "builtin:read",
        "args": {"filePath": args["path"]},
    })

    repos = call_tool({
        "source": "mcp",
        "server": "github",
        "name": "search_repos",
        "args": {"query": "foxwarm"},
    })

    screenshot = call_tool({
        "source": "node",
        "nodeId": args["nodeId"],
        "name": "android_screenshot",
        "args": {"inline": True},
    })

    return {"content": content, "repos": repos, "screenshot": screenshot}
```

For a simple builtin call, the string form is supported:

```python
content = call_tool("read", {"filePath": "README.md"})
```

ToolScript returns the concrete tool's direct result, normalized to Python-native strings, lists, dictionaries, and scalar values. It does not wrap every result in one common envelope.

Common shapes:

| Call | Return value |
| --- | --- |
| `read` on a text file | string containing file text |
| `read` on a directory | string containing a formatted directory listing |
| `read` on an image | dictionary with image metadata and inline data |
| `exec` | string containing command output and any timeout/truncation notice |
| `write` / `edit` | success string; failure raises an exception |
| `apply_patch` | string summarizing changed files |
| `search_tools` | dictionary containing `count`, `totalMatched`, and `tools` |
| `request_model_without_context` | dictionary containing `text` |

Use `search_tools` in the normal agent loop before scripting an unfamiliar tool. Tool discovery describes inputs; it does not guarantee a uniform output schema.

Nested relative file paths and `exec.cwd` values resolve from the owner session's working directory. They do not resolve from the ToolScript file's directory. Pass explicit paths through `args` when the session working directory is not guaranteed.

Nested calls execute normally and appear as ToolScript subcalls, but they are not appended as separate tool messages in the outer session history.

### `ask_agent(...)`

`ask_agent(question)` pauses the run and returns control to the owning agent:

```python
def main(args):
    answer = ask_agent("Continue? Reply yes or no.")
    return {"answer": answer}
```

The run returns:

- `status: "waiting"`
- `waitingReason: "agent"`
- `continuationId`
- `question`

Resume it with the same `runId` and `continuationId`:

```text
continue_script({runId: "...", continuationId: "...", input: "yes"})
```

`continue_script.input` is a string. For structured input, pass JSON text and parse it with `json.loads(...)` inside the script.

### `request_model_without_context(...)`

This performs one model request without the owner's conversation history and without tools:

```python
def main(args):
    summary = request_model_without_context(
        "Summarize this in one sentence: " + args["text"]
    )
    return summary
```

Pass `model="provider/model"` to select a model. If omitted, the owner session's selected model is used.

## Run lifecycle

### Foreground and background

`run_script(...)` executes the first slice inside the initiating tool call in both modes. `mode:"background"` does not turn an ordinary script into a detached job.

Use foreground mode for ordinary automation. Use `run_script({filePath, args, mode:"background"})` for managed-session controllers that wait on `wait_for_managed_event(...)`; those managed-event waits can wake automatically. Agent-input and timeout waits require `continue_script(...)` in either mode.

The managed controller APIs are documented in the `toolscript-managed-controller` skill.

### Safe-checkpoint timeout

Each `run_script` or `continue_script` slice has a 30-second timeout budget unless `timeoutSecs` is provided. Foxwarm checks this budget at host-call boundaries:

- an in-progress tool or model call is not interrupted when the budget expires;
- after that host call returns, the run pauses with `waitingReason: "timeout"`;
- the returned `waitingFor` includes a new `continuationId` and `canContinue: true`;
- `continue_script(...)` resumes from the saved snapshot rather than restarting the script.

A long host call can therefore take longer than `timeoutSecs` before the timeout wait is reported.

### Run management

Run management tools are discoverable rather than injected into the default tool list:

- `list_toolscript_runs`
- `get_toolscript_run`
- `cancel_toolscript_run`

Find them with `search_tools`, then invoke them through the outer `call_tool` tool. A run can be inspected or resumed only by its owner session.

## Result fields and scopes

Important fields include `runId`, `mode`, `status`, `result`, `error`, `waitingReason`, `waitingFor`, `stdout`, `executedTools`, `subCalls`, `hostCallCount`, and `lastHostCall`.

Their scopes differ:

| Field | Scope |
| --- | --- |
| persisted run `stdout` | cumulative across all slices |
| `continue_script` response `stdout` | output produced by that continuation slice |
| `executedTools` | cumulative tool names across the run |
| `subCalls` | latest execution slice |
| `hostCallCount` | latest execution slice |
| `lastHostCall` | most recent host call |
| `result` | explicit return value from a completed `main(args)` |

Use `get_toolscript_run` when cumulative stdout is needed after one or more continuations.

Statuses are `completed`, `waiting`, `failed`, and `cancelled`.

## Limits and safety

Default VM limits include:

- 64 MB memory
- recursion depth 200
- a Monty execution-duration limit initialized from the run's timeout budget and retained in snapshots
- a 30-second Foxwarm safe-checkpoint budget per run/continue slice unless `timeoutSecs` is provided

Monty does not expose an allocation-count limit. Memory, recursion, and execution-duration limits remain enforced in its isolated worker process.

ToolScript can repeat side effects quickly. Review paths, commands, write targets, node selection, and retry behavior before running a script. Prefer the normal tool loop when the flow is exploratory or only needs one or two calls.

ToolScript does not provide a direct `ask_user(...)` API. Use `ask_agent(...)` and let the owning agent decide how to interact with the user.
