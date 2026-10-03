# ToolScript examples

These examples provide small starting points for reusable tool automation.
Explore the required tools in the normal agent loop first, then encode the verified flow in a ToolScript.

Files:

- `examples/toolscript/automation_basic.py` reads a directory and a text file, pauses for agent input, and returns structured data.
- `examples/toolscript/managed_controller_basic.py` waits for one managed-session event, processes it, and releases the session.

ToolScript accepts ordinary top-level code with `args` as input:

```python
value = args.get("value", 0)
return {"value": value}
```

Nested relative paths resolve from the owner session's working directory, not from the directory containing the script file. Pass an explicit base path in `args` when the working directory is not guaranteed.

Existing files defining `def main(args):` are called automatically. Text-file reads and exec calls made inside a script add retained `content` and completeness metadata beside readable `output`; ordinary agent calls keep their current shapes. See the `toolscript-automation` skill for the byte budget, remote capability limits and structured discovery.
