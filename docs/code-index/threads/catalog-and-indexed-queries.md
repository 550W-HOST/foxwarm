# Thread: Catalog authority, projection, and indexed queries

## Producer to consumer path

```text
SessionManager bootstrap/admission or SessionSaveLane commit
  -> SessionCatalog.NormalizeAuthority / PublishAuthority
  -> catalog SQLite transaction (identity/topology/presentation/runtime summaries)
  -> SessionCatalog.Page/Children/Scopes/Resolve
  -> WebUI lists/architecture/presentation and Main lifecycle queries
```

- **Producer:** `SessionManager.LoadMainHostAsync`, `PersistentSessionAuthorityStore.Commit*`, identity/presentation/deletion lifecycle methods, and `SessionSaveLane` specialized operations provide a validated snapshot or Main-owned mutation.
- **Owner:** `SessionCatalog` owns schema/migration, projection transaction, alias/parent/count indexes, and query limits. `SessionManager` owns whether a Session is admitted/deleted/moved; catalog methods do not claim a turn owner.
- **Durable boundary:** `state/catalog.sqlite` is the Main catalog authority for canonical identity, topology/parent, aliases, presentation, and bounded runtime summaries. Per-Session JSON remains authority for semantic history, queue, wait, model/settings, and other active turn state; Archive remains immutable context/audit storage.
- **Consumers:** `SessionListQueries`, `WebUIChannel.List/Relations/Presentation`, architecture views, message-router presentation commands, and manager admission use catalog rows/projections without hydrating every Session.

## Key order and failure behavior

`SessionCatalog.Initialize` migrates/opens schema and validates indexes before owner publication. `PublishAuthority` is called after the authority store's JSON publication for semantic saves; it overlays Main-owned fields, rejects stale/missing membership unless explicit insertion is allowed, commits one projection transaction, then emits change notifications. If projection fails after JSON rename, JSON/hot state remain newer and the next strict save can republish; callers must not roll back active history from an older catalog row.

`Page`, `Children`, `ChildCounts`, `Scopes`, `Resolve`, `GetMany`, and `PathIds` enforce bounded IDs/cursors/agent forests and distinguish missing from ambiguous aliases. Count/index triggers and revision tokens support efficient WebUI refresh without becoming a second history store.

## Compatibility and migration

[Catalog schema](../units/session-catalog-schema.md) owns v1/v2 migration and `NormalizeAuthority`; [catalog mutations](../units/session-catalog-mutations.md) owns identity/presentation/deletion writes; [catalog projection](../units/session-catalog-projection.md) owns read paths. Legacy TS catalog readers are reference inputs only. A catalog row without matching authority JSON is not permission to create an empty Session lifetime.

## Representative tests

`SessionCatalogPublicationTests`; `SessionCatalogSourceTests`; `SessionCatalogTests`; `SessionIdentityBoundaryTests`; WebUI list/architecture route tests.
