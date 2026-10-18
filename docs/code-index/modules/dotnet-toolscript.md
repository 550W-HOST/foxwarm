# Module: ToolScript

Monty execution, host calls, budgets, persistence, and ownership.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

Managed ToolScript/controller execution is excluded from this delivery; ordinary Main-local ToolScript remains supported. See [delivery scope](../overview.md#d-dotnet-delivery-scope).

## Units

- [Main ToolScript runtime](../units/toolscript.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
