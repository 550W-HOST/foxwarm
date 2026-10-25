# Unit: Optional Archive lexical index

Files: `dotnet/Foxwarm/Vector/ArchiveSearchText.cs`, `dotnet/Foxwarm/Vector/SourceHanRanges.cs`, `dotnet/Foxwarm/Vector/ArchiveSearchSchema.cs`, `dotnet/Foxwarm/Vector/ArchiveSearchIndex.cs`, `dotnet/Foxwarm/Vector/VectorLexicalRuntime.cs`, `dotnet/Foxwarm/Vector/VectorLexicalLifecycle.cs`

## Purpose

Owns the opt-in disposable SQLite FTS derivative at `state/db/archive-search.sqlite`. This is not the authoritative Archive database. It supports dense/identifier/prose fusion without changing Archive or active history.

## Stable paths

- `ArchiveSearchText` applies Source-compatible well-formed Unicode, NFKC/full lowercase normalization, bounded literal FTS query compilation, and identifier/prose lanes. `SourceHanRanges` preserves the Source runtime's supplementary Han coverage.
- `ArchiveSearchIndex.Open` validates schema/version/tokenizer/triggers/identity. SQLite schema version remains 1; normalizer version 2 uses the shared Unicode 17 lowercase tables. Existing normalizer-1 files are retained inputs that require the existing shadow rebuild, rather than being queried with mismatched normalization. Documents and their local progress checkpoint replace atomically; checkpoint failure rolls back the corresponding FTS changes. Session and cumulative fork predicates remain SQL-bounded.
- `VectorLexicalRuntime.Schedule` has an independent 50-message/block/five-minute non-sliding scheduler. Dense token thresholds do not force lexical progress. Forced retry, startup and shutdown flush through its serialized writer chain.
- Startup and shadow catchup use the Source branch-backed `LocalVectorMaxima` inventory. Retained physical-only old payload rows do not become forced scheduler identities; canonical branches continue to index through ordinary alias-aware Archive reads without inventing old checkpoints or deleting historical rows.
- `QueryAsync` requires configured lexical plus hybrid search. It reads bounded FTS hits under the lexical owner lock without query-time Archive inventory, statistics, identity or checkpoint snapshots. Ready partial hits remain useful during ordinary indexing lag. Unavailable/backfilling/rebuilding/query-error metadata lets recall choose its bounded transient fallback.
- `RenameAsync`, `ResetAsync` and `ForkAsync` maintain derived source identity and checkpoints; pre-initialization lifecycle calls operate without loading native LanceDB. Main-only presentation changes do not rewrite archived Agents.

## Shadow rebuild and recovery

A normalizer-version mismatch follows the same rebuild-required path as an incompatible derivative. While rebuilding, lexical query metadata reports unavailable/backfilling and no indexed hits; ordinary recall retains its existing bounded transient fallback. Archive, active history and dense storage remain under their existing owners.

A rebuild-required index preserves the old active file and writes `.next`. Runtime free-space admission uses the Source old-size-plus-64-MiB requirement. Catchup repeats against current authoritative maxima before promotion. File promotion uses `.bak`, validation and directory synchronization; failed promotion restores the old active file and keeps a resumable next generation. Startup can resume next, restore backup, reconcile pending resets and prune derived Sessions without making FTS a new authority. It adds no cross-storage transaction or permanent recovery ledger.

Lexical errors are observable derivative state, not a reason to fail a previously committed Session append/compaction. Cleanup stops deadlines and drains accepted writer work before database close. Maintenance uses SQLite's existing optimize/checkpoint path under the same owner serialization.

## Tests

`VectorLexicalTests` qualifies document/checkpoint rollback, real literal/Han FTS and scope, independent deadlines, actual shadow promotion failure/resume and actual rebuild space rejection. `VectorInteropTests` retains Source-produced legacy input, rebuilds its older lexical normalization through the managed owner, and verifies managed cold reopen/progress and dense lineage clipping. Retired Source readers are not required to reopen the new normalizer output. `VectorLexicalTests.UnicodeUpgrade.cs` loads a captured Unicode-16 index, holds the actual shadow catchup, checks unavailable metadata before promotion, and verifies successful contextual-sigma queries after rebuild while preserving authority/history and dense rows. `VectorMainCallerTests` qualifies ready partial-hit recall versus bounded unavailable-index fallback, alias rename and legitimate captured lineage after a cross-Agent move; `VectorSearchQualityTests` compares actual Source hybrid selection/fusion.

`VectorInteropTests.Startup_matches_Source_for_retained_alias_rows_and_drains_later_canonical_work` compares actual Source startup against C# on the historical moved-log import shape: old physical raw/block rows coexist with canonical rows and an old-to-current reservation, but only the canonical branch exists. It requires finite lexical completion, truthful old/current checkpoints, later canonical work in local and supervised-child owners, alias-readable authority and retained old physical rows. The fixture seeds only persisted historical rows; it does not mutate scheduler state.
