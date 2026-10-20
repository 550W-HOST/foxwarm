# Module: Models

Model configuration, routing, provider adapters, streaming, retries, images, and journaling.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Shared SQLite writer mechanics](../units/dotnet-sqlite-writers.md)

- [Model configuration and routing](../units/model-configuration.md)
- [Provider-neutral request history and OpenAI wire helpers](../units/model-common-wire.md)
- [Anthropic and Chat Completions adapters](../units/model-anthropic-completions.md)
- [Responses HTTP and WebSocket adapters](../units/model-responses.md)
- [LLM request journal](../units/model-journal.md)
- [Bounded raw interaction diagnostics](../units/model-raw-diagnostics.md)
- [.NET developer tools](../units/devtools.md)
- [Image blobs, codecs, and transport](../units/images.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
