def main(args):
    base_dir = args.get("baseDir", "examples/toolscript").rstrip("/")

    print("starting automation example")

    listing = call_tool({
        "source": "node",
        "name": "read",
        "args": {"filePath": base_dir},
    })
    listing_preview = listing[:200].replace("\n", " ")
    print(f"listing: {listing_preview}")

    doc = call_tool({
        "source": "node",
        "name": "read",
        "args": {"filePath": base_dir + "/README.md"},
    })
    doc_excerpt = doc[:160].replace("\n", " ")
    print(f"documentation: {doc_excerpt}")

    label = ask_agent("Reply with a short label")

    return {
        "label": label,
        "listingPreview": listing_preview,
        "documentationExcerpt": doc_excerpt,
    }
