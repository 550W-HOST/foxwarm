# Module: Sessions

Session identity, ownership, lifecycle, persistence, catalog projections, and serialized turns.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Session value types, messages, identity, and presentation](../units/session-domain.md)
- [Session manager bootstrap, admission, and catalog publication](../units/session-manager-bootstrap.md)
- [Session manager lifecycle, deletion, and identity moves](../units/session-manager-lifecycle-identity.md)
- [Session manager Agent, setup, files, knowledge, waits, and compaction](../units/session-manager-operations.md)
- [Session manager tasks, timers, and ToolScript launch](../units/session-manager-services.md)
- [Session runtime, owner, and turn runner](../units/session-turns.md)
- [Persistent Session authority store](../units/session-authority-store.md)
- [Session authority JSON and atomic file writes](../units/session-authority-json.md)
- [Session catalog schema, bootstrap, and migration](../units/session-catalog-schema.md)
- [Session catalog projections and indexed queries](../units/session-catalog-projection.md)
- [Session catalog authority, identity, deletion, and presentation mutations](../units/session-catalog-mutations.md)
- [Archive message store and read queries](../units/archive-message-store.md)
- [Archive branches, blocks, and reservations](../units/archive-branch-lineage.md)
- [Archive identity reservations and Session identity moves](../units/archive-identity-and-moves.md)
- [Session deletion coordination storage](../units/session-deletion-storage.md)
- [Session save-lane core](../units/session-save-lane-core.md)
- [Session wait and queue admission save operations](../units/session-save-lane-wait.md)
- [Session save-lane fork, clear, and lifecycle operations](../units/session-save-lane-lifecycle.md)
- [Session save-lane settings, prompt cache, goals, retry, and compact wake state](../units/session-save-lane-state-ops.md)
- [.NET test suite](../units/dotnet-tests.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
