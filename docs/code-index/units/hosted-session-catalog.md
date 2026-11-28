# Unit: Hosted Session catalog

Files: `dotnet/Foxwarm/Hosted/Postgres/Catalog/PgSessionCatalog.cs`, `dotnet/Foxwarm/Hosted/Postgres/Catalog/PgSessionCatalog.Queries.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Catalog.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0200_session_catalog.sql`

## Purpose

`PgSessionCatalog` is the [`ISessionCatalogStore`](./storage-context.md#session-catalog) of a hosted tenant. It keeps the file catalog's observable behavior: projection, aliases and topology, the maintained counts and subtree activity, and the list, tree, group and descendant reads with their keyset order. It writes through the tenant's fenced [`TenantDb`](./hosted-database.md#d-hosted-write-fence). The file catalog's schema, triggers and queries are described in the [catalog schema](./session-catalog-schema.md), [projection](./session-catalog-projection.md) and [mutation](./session-catalog-mutations.md) units.

## Contracts

### D-hosted-catalog-parity

**Derived from the approved plan (2026-11-26, catalog row).**

- **Schema.** Migration 0200 is the file catalog's schema version 3 with its additive grouping and activity objects, per tenant. The file schema's generated columns and its indexes exist here, each led by `tenant_id`. The JSON fields the SQLite queries read with `json_extract` are extracted into columns when a row is written: the open and approval question counts, and whether the wait ID is a string. Booleans stay 0/1 integers because they are sort keys.
- **Counts and activity.** The eleven SQLite count triggers and the three subtree-activity triggers become one PL/pgSQL function per row event. Each branch keeps the SQLite expression, including the order of the floating-point cost arithmetic, and runs when the SQLite trigger's columns and condition select it. `session_catalog_refresh_subtree` recomputes an ancestor chain like the file catalog's refresh statement. The per-tenant summary row is created by the first insert; a tenant without it reads as zero.
- **Order.** Text columns use byte collation (`"C"`), like SQLite's BINARY. The order keys, keyset comparisons and batch limits are the SQLite ones, so a cursor means the same row on both backends. Cursor parts bind with their column's type, so the row comparison stays an index condition. Selections the file catalog returns without an order (restart, approval and wait IDs, sequence rows) are in Session ID order.
- **Indexes.** Where a SQLite query names an index with `INDEXED BY`, the matching index exists. An `EXPLAIN` test checks the plans. The all-Sessions Flat page has no index on either backend.
- **Rules.** The presentation, deletion-selection and identity-rewrite rules live in `SessionCatalogRules`, shared with the file catalog. Each rule reads through `ICatalogRowView` inside the store's transaction and returns the rows to write.
- **Keys PostgreSQL can't hold.** Text can't contain NUL. A lookup key containing one names no row, which is what SQLite answers for it.
- **Migration.** Migration from earlier catalog layouts and TypeScript evidence stays file-only. `Exists` is always true, and `OpenIdentityRecovery` has nothing to open.

### D-hosted-catalog-revision

**Approved plan (2026-11-26, catalog row).** `Revision` is a per-tenant counter, `catalog_revision`, raised in every catalog write transaction. It rises exactly when the file catalog raises its revision: always for authority publication, rename, identity rewrite, deletion and seeding, only on a real change for presentation mutations and `RenameIfUnnamed`. The value reported is this store instance's identity plus the counter, so a cursor issued by an earlier process never applies. A lost `COMMIT` is resolved by checking the counter for the written value. `Changed` stays in-process, because the tenant has a single owner.

### D-hosted-catalog-serialization

**PostgreSQL snapshots and serialized writes.** Authority publication and presentation commits wait asynchronously for the catalog writer, and raise `Changed` only after releasing it. A synchronous nested read from a mutation joins the writer's transaction. Independent asynchronous catalog queries take a tenant statement slot and run concurrently in read-only repeatable-read transactions. Their synchronous callbacks read rows, revisions, counts and archive sequences from their own snapshot; another query or presentation write can complete meanwhile. Exact point reads from other stores join that caller's tenant transaction. File mode keeps SQLite's existing serialization.

`GET /api/sessions` collects complete catalog rows once, overlays the local projections, and enriches them within one catalog query. Rendering and model configuration reads run after the transaction releases its slot. A hot-parent change compares a row and revision from the same snapshot and retries if a writer has since raised the revision.

Presentation route entry and cold identity admission await canonical resolution. A hot parent change carries the row it reconciled into local capture, wait transitions and channel-turn notification. List rendering reads one model snapshot per nonempty batch, after the catalog transaction releases its slot. The model owner waits asynchronously for its gate and the tenant's configuration-document read before rendering any rows.

## Tests

- `CatalogStarvationTests` drives concurrent presentation updates with a capped worker pool and verifies that queued list and Task reads yield while the tenant's only statement slot is occupied. `HostedRuntimesInProcessTests` requests an exact WebUI row with PostgreSQL-backed model configuration and checks the configured default model.

- **`SessionCatalogContractTests`** (abstract) runs as `FileSessionCatalogContractTests` and `PostgresSessionCatalogContractTests` (`Backend=postgres`). It was extracted from the `SessionCatalog*Tests` classes, which keep only file-only behavior: SQLite plans and statement observation, upgrades of earlier layouts, writers that bypass the store and SQLite lock failures. The maintained-value checks compare the stored count and activity tables with a full recomputation after every step.
- **`PostgresSessionCatalogTests`** covers fencing of every write operation after a takeover (nothing written, no event, revision unchanged), the lost-`COMMIT` cases through `PgTcpProxy`, the revision counter, tenant separation and the index plans of pages, child windows, group pages, recent-child counts, startup selections and alias resolution.
- **`PostgresSessionCatalogGoldenTests`** compares every read and a sequence of presentation and deletion writes on both backends over a copy of a real catalog, named by `FOXWARM_TEST_GOLDEN_CATALOG`. Without the variable it does nothing. It reports counts and JSON paths of differences, never values.
- Catalog-only list classes seed rows through the backend-neutral `Upsert` test extension.

## Open Questions

- **Write round trips.** A row write is several statements (row upsert, alias replacement) plus trigger work, so a sibling re-rank of a large group costs one round trip per statement per row. Batching them is unmeasured.
