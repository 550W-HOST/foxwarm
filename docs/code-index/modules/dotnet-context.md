# Module: Context and memory

Canonical messages, compaction, immutable Archive navigation, Agent memory, and recall.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Compaction plans and Archive recall](../units/session-compaction.md)
- [Conditional Agent memory](../units/conditional-memory.md)
- [Vector owner and Main callers](../units/vector-owner.md)
- [Vector storage and committed indexing](../units/vector-indexing.md)
- [Optional lexical index](../units/vector-lexical.md)
- [Semantic recall and authoritative previews](../units/vector-recall.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
