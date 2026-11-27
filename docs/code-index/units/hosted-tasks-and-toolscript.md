# Unit: Hosted Task rows and ToolScript run records

Files: `dotnet/Foxwarm/Hosted/Postgres/Tasks/PgTaskRowStore.cs`, `dotnet/Foxwarm/Hosted/Postgres/ToolScriptRuns/PgToolScriptRunStore.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.Tasks.cs`, `dotnet/Foxwarm/Hosted/PostgresStorageContext.ToolScriptRuns.cs`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0400_tasks.sql`, `dotnet/Foxwarm/Hosted/Schema/Migrations/0401_toolscript_runs.sql`, `dotnet/Foxwarm.Tests/Storage/PostgresTaskRowStoreTests.cs`, `dotnet/Foxwarm.Tests/ToolScript/PostgresToolScriptRunStoreTests.cs`

## Task rows

`PgTaskRowStore` implements `ITaskRowStore`; `TaskStore` still owns validation, status and assignment rules, notifications and reminder progress. The Postgres schema keeps the row contract's column names and value types. Tenant-composite references constrain task parents and notes to the current tenant; a tenant-unique legacy-goal reference preserves migration idempotency.

- `Write` takes the tenant's Task advisory transaction lock at the start of a `READ COMMITTED` transaction. The lock excludes writers even across separate store objects and covers the entire callback.
- `Read` uses `REPEATABLE READ READ ONLY`, so an assembled detail or list and its counts see the same snapshot.
- `Direct` gives each row operation its own transaction. Each write takes the same lock; a later statement's failure cannot roll it back.
- Task tool and HTTP transactions await the `TaskStore` semaphore and the tenant transaction slot separately. PostgreSQL uses the same row rules, snapshot isolation and transaction verification as synchronous callers; SQLite executes the transaction directly after entering the store gate. Actor, assignment target and scoped Agent lookups await catalog admission; owner and creator authorization facts come from one admitted Task row. Read-only actions need no authority reminder anchor.
- Lists and lookup tie-breakers use SQLite's byte ordering and explicit null placement. The note identity preserves insertion order, independent of the note time.

## ToolScript run records

`PgToolScriptRunStore` implements `IToolScriptRunStore`. Each run keeps one opaque UTF-8 JSON `bytea`; owner, status and update time are extracted for listing. Lists filter by owner and optional status and sort by update time descending, then by run ID in byte order. The run lane stays in process. Reads use the same budget accounting and number materialization as the file backend. Bounded serialization stages the bytes through an ephemeral file so sending a large record does not require another full in-process buffer.

Both stores are built by [the hosted storage context](./hosted-runtime.md#d-hosted-storage-context) and write behind the [tenant epoch fence](./hosted-database.md#d-hosted-write-fence). A ToolScript replacement can verify a lost commit by comparing the saved bytes. Task callbacks verify the PostgreSQL transaction ID, so a lost reply never causes the callback to replay.

## Tests

The Task contract reuses the same action sequence as the SQLite and in-memory stores. It also checks transaction boundaries, ordering and stale-epoch rejections for inserts, updates, notification settlement and note appends. The ToolScript contract checks reopened records, filtered ordering and stale-epoch rejection for both inserting and replacing a run. Backend-neutral runtime tests exercise the Task and ToolScript callers with real Postgres stores; file-stage and old SQLite schema tests stay file-only.
