print("starting automation example")

listing = call_tool(
    "skill",
    {"action": "load", "skillName": "toolscript-automation", "path": "examples/"},
)
listing_preview = listing["output"][:200].replace("\n", " ")
print(f"listing: {listing_preview}")

doc = call_tool(
    "skill",
    {"action": "load", "skillName": "toolscript-automation", "path": "examples/README.md"},
)
doc_excerpt = doc["content"][:160].replace("\n", " ")
print(f"documentation: {doc_excerpt}")

label = ask_agent("Reply with a short label")

return {
    "label": label,
    "listingPreview": listing_preview,
    "documentationExcerpt": doc_excerpt,
}
