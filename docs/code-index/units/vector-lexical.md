# Unit: Optional Archive lexical index

Files: `dotnet/Foxwarm/Vector/ArchiveSearchText.cs`, `dotnet/Foxwarm/Vector/SourceHanRanges.cs`, `dotnet/Foxwarm/Vector/ArchiveSearchSchema.cs`, `dotnet/Foxwarm/Vector/ArchiveSearchIndex.cs`, `dotnet/Foxwarm/Vector/VectorLexicalRuntime.cs`, `dotnet/Foxwarm/Vector/VectorLexicalLifecycle.cs`

## Purpose

Owns the opt-in disposable SQLite FTS derivative at `state/db/archive-search.sqlite`. This is not the authoritative Archive database. It supports dense/identifier/prose fusion without changing Archive or active history.

## Stable paths

- `ArchiveSearchText` applies Source-compatible well-formed Unicode, NFKC/full lowercase normalization, bounded literal FTS query compilation, and identifier/prose lanes. `SourceHanRanges` preserves the Source runtime's supplementary Han coverage.
- `ArchiveSearchIndex.Open` validates schema/version/tokenizer/triggers/identity. Documents and their local progress checkpoint replace atomically; checkpoint failure rolls back the corresponding FTS changes. Session and cumulative fork predicates remain SQL-bounded.
- `VectorLexicalRuntime.Schedule` has an independent 50-message/block/five-minute non-sliding scheduler. Dense token thresholds do not force lexical progress. Forced retry, startup and shutdown flush through its serialized writer chain.
- Startup and shadow catchup use the Source branch-backed `LocalVectorMaxima` inventory. Retained physical-only old payload rows do not become forced scheduler identities; canonical branches continue to index through ordinary alias-aware Archive reads without inventing old checkpoints or deleting historical rows.
- `QueryAsync` requires configured lexical plus hybrid search. Exact current-session coverage snapshots are checked before and after FTS query; hits can remain useful while coverage becomes incomplete. Unavailable/backfilling/rebuilding/query-error metadata lets recall choose its bounded transient fallback.
- `RenameAsync`, `ResetAsync` and `ForkAsync` maintain derived source identity and checkpoints; pre-initialization lifecycle calls operate without loading native LanceDB. Main-only presentation changes do not rewrite archived Agents.

## Shadow rebuild and recovery

A rebuild-required index preserves the old active file and writes `.next`. Runtime free-space admission uses the Source old-size-plus-64-MiB requirement. Catchup repeats against current authoritative maxima before promotion. File promotion uses `.bak`, validation and directory synchronization; failed promotion restores the old active file and keeps a resumable next generation. Startup can resume next, restore backup, reconcile pending resets and prune derived Sessions without making FTS a new authority. It adds no cross-storage transaction or permanent recovery ledger.

Lexical errors are observable derivative state, not a reason to fail a previously committed Session append/compaction. Cleanup stops deadlines and drains accepted writer work before database close. Maintenance uses SQLite's existing optimize/checkpoint path under the same owner serialization.

## Tests

`VectorLexicalTests` qualifies document/checkpoint rollback, real literal/Han FTS and scope, independent deadlines, exact coverage races, actual shadow promotion failure/resume and actual rebuild space rejection. `VectorInteropTests` reopens the same lexical schema and progress across Source/C# writers. `VectorMainCallerTests` qualifies alias rename and legitimate captured lineage after a cross-Agent move; `VectorSearchQualityTests` compares actual Source hybrid selection/fusion.

`VectorInteropTests.Startup_matches_Source_for_retained_alias_rows_and_drains_later_canonical_work` compares actual Source startup against C# on the historical moved-log import shape: old physical raw/block rows coexist with canonical rows and an old-to-current reservation, but only the canonical branch exists. It requires finite lexical completion, truthful old/current checkpoints, later canonical work in local and supervised-child owners, alias-readable authority and retained old physical rows. The fixture seeds only persisted historical rows; it does not mutate scheduler state.
