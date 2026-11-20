# Unit: Vector storage and committed Archive indexing

Files: `dotnet/Foxwarm/Vector/VectorConfiguration.cs`, `dotnet/Foxwarm/Vector/VectorText.cs`, `dotnet/Foxwarm/Vector/VectorRows.cs`, `dotnet/Foxwarm/Vector/VectorTable.cs`, `dotnet/Foxwarm/Vector/VectorRuntime.cs`, `dotnet/Foxwarm/Vector/VectorMaintenance.cs`, `dotnet/Foxwarm/Vector/VectorOperationGate.cs`

## Purpose

Owns the enabled derived dense index, embedding requests, raw/block/fact recipes, Archive progress scheduling, and owner-local maintenance. Archive and active Session JSON remain the authorities. [Owner placement](./vector-owner.md), [lexical indexing](./vector-lexical.md), and [retrieval](./vector-recall.md) own the adjacent boundaries.

## Stable methods and callers

- `VectorConfiguration.Capture` consumes validated app configuration once: object/boolean/absent Vector state, legacy `ollamaBaseUrl`, normalized endpoint, lexical/hybrid opt-ins, `dbWorkers` default true, and configured maintenance retention.
- `VectorText` translates substantive model-visible message/tool/image text, wrapper exclusions, Source token estimation, Unicode handling, and embedding truncation. A complete recognized channel wrapper supplies the entire part body; its sibling fields are not formatted, while ordinary system/text parts retain both fields. Query embeddings add the Source query instruction; document embeddings do not. Both use `qwen3-embedding:0.6b`, 1024 finite components and the existing 60-second HTTP bound.
- `VectorRows` builds overlapping raw segments, deterministic raw chunks, block chunks, and deduplicated facts. Fact identity retains the persisted Source kind-plus-normalized-text SHA-256 recipe, attribution and context.
- `VectorTable.OpenAsync` owns exactly one connection/table in its runtime. Existing `messages_v7` tables open without conversion; new tables use the explicitly nullable Source-equivalent Arrow schema, Float64 numeric metadata, a nullable fixed-size Float32 vector, and storage format `2.0`.
- `VectorRuntime.Schedule`, `ForceAsync` and `IndexFactsAsync` are called after actual authority publication, at explicit `/session index`, and from committed compaction. Startup visits pending local Archive owners parent-before-child. Readiness does not mean backfill completed.
- `VectorMaintenance` translates startup, 128-successful-mutation, one-minute non-sliding coalescing, daily periodic and one-hour retry scheduling. `VectorOperationGate` lets ordinary operations overlap while queued exclusive maintenance runs before waiting ordinary work.

## Ordering and failure contract

Per-Session force requests enqueue their own captured target run behind any active indexing work and await that run, including its failure. Background scheduling still coalesces into the existing batch/deadline; a force caller does not wait for later appends beyond its captured target.

Raw batches rebuild the persisted tail: delete overlapping derived rows first, embed/add rebuilt rows, then advance SQLite progress. An embedding/add/checkpoint failure does not claim progress or undo the earlier derived deletion. A retry uses committed Archive and the old checkpoint. Block IDs merge atomically before checkpoint advancement; facts merge by deterministic ID, making retries idempotent. Startup replays raw/block progress, not historical fact publication hooks.

Dense progress lives in Source-compatible `archive_checkpoints`, through the existing [Archive writer](./archive-message-store.md). It does not become a new authority or an additional requirement for Session commit success. Maintenance uses actual SDK table stats, versions and optimize, retains configured age and `deleteUnverified:false`, and always attempts lexical maintenance even after a dense error. Pending retries/timers stop on shutdown; accepted work drains before table/connection disposal.

Rename moves scheduler/checkpoint state but deliberately does not rewrite old Lance row identities. Same-Agent scoped retrieval can follow an Archive alias; destination dense searches can miss old rows. No row migration, forced re-embedding, durable fencing or new recovery transaction is implied. The canonical retrieval scope check is owned by [Vector recall](./vector-recall.md).

## Source-time metadata compatibility

Block and modern fact date admission uses the canonical block's source range. New fact producers hydrate source endpoints through effective Archive lineage; `timestamp` retains fact creation time, while `start_timestamp`/`end_timestamp` carry source times. Dense block production shares the same endpoint hydration. Missing block/fact source ranges cannot qualify a dated search, while undated compatibility retrieval remains available. Recorded source timestamps take precedence; absent endpoint rows do not replace a retained known range with creation time.

Before enabling dense searches, `VectorTable.RepairSourceTimesAsync` repairs existing block and modern fact source columns once. It collects distinct Session/block locators in bounded 128-row reads, then repairs mismatched locators in batches of at most 128 through native matched-only, partial-schema `MergeInsert` on `(session_id, block_id, memory_kind)`. Each locator supplies one block and one fact match; only the two source-time columns are replaced, and absent matches are never inserted. This supports multiple chunks/facts per locator and distinct ranges within one batch without a native version per locator. Already-correct ranges, including null/unknown ranges, are skipped so interrupted retries retain their completed work. Cancellation is observed between read/update operations and before completion marking. Row IDs, text, embeddings, original timestamps and unrelated rows remain unchanged. A field-metadata completion marker is written only after every update succeeds; interrupted work is idempotently retried on reopening, without a separate journal or fact reconstruction. Unknown sources retain their derived rows with unknown source columns and a bounded metadata-only diagnostic. The owner remains unready throughout repair, while Main continues HTTP and Session startup without awaiting that optional initialization. Initialization failure leaves the optional Vector owner unavailable through its existing initialization boundary. The repair performs no compaction, cleanup, or source deletion; the existing maintenance policy is unchanged. Locator enumeration remains proportional to historical block/fact rows, with an in-memory distinct-locator map and bounded native read/write payloads. Large tables may therefore remain unavailable for semantic search until enumeration and batched commits finish.

`VectorSourceTimeTests` exercises multiple read batches, multiple facts per block, retained known block ranges without raw endpoint rows, missing sources, content/vector preservation, completed reopen, interruption/retry and initialization failure followed by recovery. No query-time full scan or dense rebuild is needed.

## SDK and platform boundary

The native dependency is exactly `LanceDB` NuGet `2.5.0` (community SDK/native Lance 8.0.0), with Apache Arrow 22.1.0. Managed and native Main use the same [source-built C# binding](dotnet-lancedb-binding.md), whose pinned source and focused metadata patch are maintained locally. Its builder/RecordBatch API replaces the Node binding, not the storage engine. New-table format 2.0 is explicit because the bindings' defaults differ. Existing tables remain intact.

The package's Linux x64 asset requires glibc 2.39; release packages replace it with a build of the same pinned source on glibc 2.34 (see [release packages](./release-packages.md#native-linux-package)), and other builds keep it; the package has no Linux-musl or Linux-arm64 native asset. Windows x64 requires system Visual C++/Universal C runtime dependencies; qualification versions do not establish their minimum. Disabled Vector does not instantiate the native owner or create vector/FTS storage. Build success alone is not platform runtime qualification.

## Tests

`VectorRecipeTests`, `VectorStorageTests`, `VectorInteropTests`, `VectorCompactionTests`, and `VectorMaintenanceTests` use controlled loopback embeddings, actual native tables, actual committed Archive, and frozen TypeScript comparisons. The interop fixture retains Source-produced inputs and checks managed indexing/cold reopen, including progress, schema, Lance rows and fork caps. Legacy lexical normalizers rebuild through the existing derived-index lifecycle; returning current normalized output to retired Source is not a compatibility requirement. No live provider, Agent or data root is required.
