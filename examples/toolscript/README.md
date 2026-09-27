# ToolScript examples

These examples provide small starting points for reusable tool automation.
Explore the required tools in the normal agent loop first, then encode the verified flow in a ToolScript.

Files:

- `examples/toolscript/automation_basic.py` reads a directory and a text file, pauses for agent input, and returns structured data.
- `examples/toolscript/managed_controller_basic.py` waits for one managed-session event, processes it, and releases the session.

Every ToolScript defines an explicit entrypoint and returns its result:

```python
def main(args):
    ...
    return {...}
```

Nested relative paths resolve from the owner session's working directory, not from the directory containing the script file. Pass an explicit base path in `args` when the working directory is not guaranteed.
