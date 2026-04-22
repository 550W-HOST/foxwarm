print("starting automation example")

files = call_tool("list_files", {
    "dirPath": "examples/toolscript",
    "recursive": False,
    "includeHidden": False,
    "limit": 20,
})
count = files.get("count", 0) if isinstance(files, dict) else 0
print(f"example file count: {count}")

doc = call_tool("read", {"filePath": "README.md"})
excerpt = doc[:160].replace("\n", " ") if isinstance(doc, str) else str(doc)[:160]
print(f"excerpt: {excerpt}")

label = ask_agent("Reply with a short label")

{
    "label": label,
    "exampleFileCount": count,
}