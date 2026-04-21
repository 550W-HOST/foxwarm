print("starting automation example")

found = find_tool("read file")
tool = found["tool"] if isinstance(found, dict) else None
tool_name = tool.get("name", "") if isinstance(tool, dict) else ""
print(f"top tool: {tool_name}")

doc = call_tool("read", {"filePath": "skills/toolscript_automation/SKILL.md"})
excerpt = doc[:160].replace("\n", " ") if isinstance(doc, str) else str(doc)[:160]
print(f"excerpt: {excerpt}")

label = ask_agent("Reply with a short label")

{
    "label": label,
    "topTool": tool_name,
    "resultCount": found.get("count", 0) if isinstance(found, dict) else 0,
}