# Unit: Vector storage and committed Archive indexing

Files: `dotnet/Foxwarm/Vector/VectorConfiguration.cs`, `dotnet/Foxwarm/Vector/VectorText.cs`, `dotnet/Foxwarm/Vector/VectorRows.cs`, `dotnet/Foxwarm/Vector/VectorTable.cs`, `dotnet/Foxwarm/Vector/VectorRuntime.cs`, `dotnet/Foxwarm/Vector/VectorMaintenance.cs`, `dotnet/Foxwarm/Vector/VectorOperationGate.cs`

## Purpose

Owns the enabled derived dense index, embedding requests, raw/block/fact recipes, Archive progress scheduling, and owner-local maintenance. Archive and active Session JSON remain the authorities. [Owner placement](./vector-owner.md), [lexical indexing](./vector-lexical.md), and [retrieval](./vector-recall.md) own the adjacent boundaries.

## Stable methods and callers

- `VectorConfiguration.Capture` consumes validated app configuration once: object/boolean/absent Vector state, legacy `ollamaBaseUrl`, normalized endpoint, lexical/hybrid opt-ins, `dbWorkers` default true, and configured maintenance retention.
- `VectorText` translates substantive model-visible message/tool/image text, wrapper exclusions, Source token estimation, Unicode handling, and embedding truncation. Query embeddings add the Source query instruction; document embeddings do not. Both use `qwen3-embedding:0.6b`, 1024 finite components and the existing 60-second HTTP bound.
- `VectorRows` builds overlapping raw segments, deterministic raw chunks, block chunks, and deduplicated facts. Fact identity retains the persisted Source kind-plus-normalized-text SHA-256 recipe, attribution and context.
- `VectorTable.OpenAsync` owns exactly one connection/table in its runtime. Existing `messages_v7` tables open without conversion; new tables use the explicitly nullable Source-equivalent Arrow schema, Float64 numeric metadata, a nullable fixed-size Float32 vector, and storage format `2.0`.
- `VectorRuntime.Schedule`, `ForceAsync` and `IndexFactsAsync` are called after actual authority publication, at explicit `/session index`, and from committed compaction. Startup visits pending local Archive owners parent-before-child. Readiness does not mean backfill completed.
- `VectorMaintenance` translates startup, 128-successful-mutation, one-minute non-sliding coalescing, daily periodic and one-hour retry scheduling. `VectorOperationGate` lets ordinary operations overlap while queued exclusive maintenance runs before waiting ordinary work.

## Ordering and failure contract

Raw batches rebuild the persisted tail: delete overlapping derived rows first, embed/add rebuilt rows, then advance SQLite progress. An embedding/add/checkpoint failure does not claim progress or undo the earlier derived deletion. A retry uses committed Archive and the old checkpoint. Block IDs merge atomically before checkpoint advancement; facts merge by deterministic ID, making retries idempotent. Startup replays raw/block progress, not historical fact publication hooks.

Dense progress lives in Source-compatible `archive_checkpoints`, through the existing [Archive writer](./archive-message-store.md). It does not become a new authority or an additional requirement for Session commit success. Maintenance uses actual SDK table stats, versions and optimize, retains configured age and `deleteUnverified:false`, and always attempts lexical maintenance even after a dense error. Pending retries/timers stop on shutdown; accepted work drains before table/connection disposal.

Rename moves scheduler/checkpoint state but deliberately does not rewrite old Lance row identities. Same-Agent scoped retrieval can follow an Archive alias; destination dense searches can miss old rows. No row migration, forced re-embedding, durable fencing or new recovery transaction is implied. The canonical retrieval scope check is owned by [Vector recall](./vector-recall.md).

## SDK and platform boundary

The dependency is exactly `LanceDB` NuGet `2.5.0` (community SDK/native Lance 8.0.0), with Apache Arrow 22.1.0. Its builder/RecordBatch API replaces the Node binding, not the storage engine. New-table format 2.0 is explicit because the bindings' defaults differ. Existing tables remain intact.

The pinned Linux x64 assets require glibc 2.39; the package has no Linux-musl or Linux-arm64 native asset. Windows x64 requires system Visual C++/Universal C runtime dependencies; qualification versions do not establish their minimum. Disabled Vector does not instantiate the native owner or create vector/FTS storage. Build success alone is not platform runtime qualification.

## Tests

`VectorRecipeTests`, `VectorStorageTests`, `VectorInteropTests`, `VectorCompactionTests`, and `VectorMaintenanceTests` use controlled loopback embeddings, actual native tables, actual committed Archive, and frozen TypeScript comparisons. The interop fixture crosses Source → C# → Source, including progress, schema, Lance rows and fork caps. No live provider, Agent or data root is required.
