# ToolScript automation example

These examples provide small starting points for reusable tool automation.
Explore the required tools in the normal agent loop first, then encode the verified flow in a ToolScript.

`automation_basic.py` lists this examples directory and reads this text file through `skill load`, pauses for agent input, and returns structured data. Run it with `ctl skill run toolscript-automation --script examples/automation_basic.py`; it works from any Node.

ToolScript accepts ordinary top-level code with `args` as input:

```python
value = args.get("value", 0)
return {"value": value}
```

Skill resource references are relative to the skill directory. A script run from a skill still runs as the Session: nested tools use its current Node, and nested relative paths resolve from its working directory, not from the skill directory. Read the skill's own files with `skill load` and a `path`, as the example does.

Existing files defining `def main(args):` are called automatically. Text-file reads and exec calls made inside a script add retained `content` and completeness metadata beside readable `output`; ordinary agent calls keep their current shapes. See the `toolscript-automation` skill for the byte budget, remote capability limits and structured discovery.
