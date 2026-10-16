# Unit: Session catalog schema, bootstrap, and migration

Files: `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Schema.cs`, `dotnet/Foxwarm/Sessions/Storage/SessionCatalog.Migration.cs`

## Purpose

Creates and upgrades the Main-owned `state/catalog.sqlite`, defines its normalized tables/indexes/count triggers, and imports older catalog/authority evidence into the current projection without making catalog fields active Session authority.

## Stable methods and callers

- `Initialize`/`Open` migrate schema version 1 to 2, enable WAL/full sync/foreign keys, and reject unsupported versions.
- Ordinary `Get`/`Resolve` reads lease separate provider-pooled read-only connections only after initialization finishes. The writer connection remains monitor-owned; disposal clears this catalog's reader pool and later access retains the existing reopen behavior.
- `ImportDotNetV1` and migration helpers freeze/validate source inputs, build normalized rows, and publish only after the declared source set remains unchanged.
- `NormalizeAuthority` transfers only compatibility fields from legacy catalog input, validates identity/agent/version, and leaves unsupported semantic shapes for `SessionAuthorityDocument` to reject.
- Schema helpers define alias, parent, projection, count, and presentation-root indexes used by bounded queries.

Callers: `SessionManager.LoadMainHostAsync`, `PersistentSessionAuthorityStore.LoadAsync`, `CommittedArchiveIdentity.InitializeAsync`, and catalog source/publication tests.

## Contract and side effects

The catalog is a query projection. It may carry Main-only presentation metadata (`lastChannel`, parent/pinned/sidebar fields, busy/queue counters) that is intentionally not written into active Session JSON. Migration failure removes only the temporary database and leaves source files unchanged; it does not synthesize an owner from partial catalog input.

## Tests

`dotnet/Foxwarm.Tests/Sessions/SessionCatalogMigrationTests.cs`; `SessionCatalogSourceTests.cs`; `SessionCatalogPublicationTests.cs`; `dotnet/Foxwarm.Tests/Storage/TypeScriptFixtureTests.cs`.
