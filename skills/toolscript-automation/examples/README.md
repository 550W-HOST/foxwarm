# ToolScript automation example

These examples provide small starting points for reusable tool automation.
Explore the required tools in the normal agent loop first, then encode the verified flow in a ToolScript.

`automation_basic.py` reads a directory and this text file, pauses for agent input, and returns structured data. Pass the resolved path of this examples directory as `args.baseDir`. The file is a resource of the `toolscript-automation` skill and is listed when that skill is loaded.

For a controller that waits for one managed-session event, processes it, and releases the session, load `toolscript-managed-controller` and read its `examples/managed_controller_basic.py` resource.

ToolScript accepts ordinary top-level code with `args` as input:

```python
value = args.get("value", 0)
return {"value": value}
```

Skill resource references are relative to the skill directory. Resolve the example path before passing it as `run_script.filePath`, and choose the source Node that holds that file. Source selection does not change the session's current Node or working directory. Nested tools still use that current Node, and nested relative paths resolve from the owner session's working directory, not from the directory containing the script file. Pass `args.baseDir` as an absolute directory on the current Node containing this `README.md`.

Existing files defining `def main(args):` are called automatically. Text-file reads and exec calls made inside a script add retained `content` and completeness metadata beside readable `output`; ordinary agent calls keep their current shapes. See the `toolscript-automation` skill for the byte budget, remote capability limits and structured discovery.
