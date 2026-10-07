# Unit: Conditional Agent memory

Files: `dotnet/Foxwarm/Memory/ConditionalMemory.cs`

## Purpose

Parses conditional memory source/range markers and selects the sections applicable to the concrete model/context request.

## Stable symbols and callers

`ConditionalMemory.Parse`, `Select`, and range/condition records are called by `AgentMemory.Selected`/prompt preparation before `ConcreteRequestHistory` is built. The selected text is input data; this unit does not write Session authority or Archive.

## Contract and side effects

Malformed markers, unsupported conditions, and invalid ranges are explicit selection errors or ignored according to the source-compatible parser policy. Selection can alter model prompt content but cannot mutate active `history`, queue, wait, catalog, or Vector admission state.

## Tests

`dotnet/Foxwarm.Tests/Memory/ConditionalMemoryTests.cs`; selected-memory and prompt construction tests.
