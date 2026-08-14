# Unit: src-migrations

Files: src/migrations/index.ts, src/migrations/state.ts, src/migrations/embeddedContextFrontier.ts, src/migrations/embeddedContextFrontier.test.ts, src/migrations/legacyUndatedExecArtifacts.ts, src/migrations/legacyUndatedExecArtifacts.test.ts, src/migrations/sqliteOnlyArchives.ts, src/migrations/sqliteOnlyArchives.test.ts

## Purpose

Holds startup migration orchestration and migration-only data structures. Current runtime modules should stay clean: legacy formats such as standalone `*.frontier.json` are retired here without becoming current active state.

## Key Exports

- `runStartupMigrations()` — runs registered startup migrations and returns their summaries.
- `runEmbeddedContextFrontierMigration(options?)` — scans legacy frontier files unless migrationVersion says this migration already completed, preserves authoritative history, advances only a safe `nextBlockId` floor, removes any obsolete embedded field, and moves successful legacy files to backup.
- `runLegacyUndatedExecArtifactMigration(options?)` — archives eligible legacy undated persistent-exec wrapper/user/paths artifacts per agent, removes only successfully archived sources, and retries until no strict matching top-level artifacts remain.
- `EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID` — current migration id (`embedded-context-frontier-v1`).
- `LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID` — migration id for old root-level exec artifacts (`legacy-undated-exec-artifacts-v1`).
- `SQLITE_ONLY_ARCHIVES_MIGRATION_ID` — fail-closed migration for legacy large archive JSONLs (`sqlite-only-large-archives-v1`).
- `MIGRATION_VERSION_FILE` — `state/migrationVersion.json`.
- `MIGRATION_BACKUP_DIR` — `state/migration-backup`.
- `createMigrationVersionStore(filePath?)` / `readMigrationVersionState(store)` — lightweight DiskJsonData helpers for migration version state.
- Types: `MigrationVersionState`, `MigrationVersionEntry`, `EmbeddedContextFrontierMigrationResult`, `EmbeddedContextFrontierMigrationOptions`, `LegacyUndatedExecArtifactMigrationResult`, `LegacyUndatedExecArtifactMigrationOptions`.

## Behavior

- `runStartupMigrations()` is called by `sessionManager.loadSessions()` before session metadata is loaded.
- Migration version state lives at `state/migrationVersion.json` and records one entry per migration id. Completed and completed-with-failures entries both prevent repeated full scans on later startup.
- The embedded context frontier migration scans `state/sessions/**/*.frontier.json` only inside `src/migrations/embeddedContextFrontier.ts`.
- The legacy undated exec-artifact migration scans only top-level files in each agent's `.temp/exec/` directory. It recognizes only the historical wrapper, Windows user-command, and paths-metadata names with the exact `exec_<13-digit timestamp>_<8 lowercase hex>` prefix; logs, status/cwd files, subdirectories, and similarly named files remain untouched.
- Eligible old exec artifacts must have `mtime <` the local start of yesterday. Eligible files are archived into a new time-prefixed `.tar.gz` under that agent's existing `.temp/exec/archives/` directory, then unlinked only after the archive command has completed and its temporary archive has been finalized. Existing archive rotation consequently owns retention of these dedicated migration archives.
- The exec migration intentionally does not write `completed_with_failures`: it leaves its version absent until a post-pass finds no strict matching artifacts and can read the agents root plus every candidate exec root. Too-new files, archive failures, unlink failures, and unreadable scan roots therefore retry on a later startup. A later retry may create another archive for retained sources, which is safe because removal never precedes a successful archive.
- The SQLite-only migration runs first, strictly imports/verifies both large JSONL archive domains, records data-root-relative paths plus hashes/counts in an fsynced manifest, and only then durably moves sources under a path-preserving migration backup. Partial movement is restored and retried; failures never record completion.
- Canonical message/block structures are validated before bootstrap mutations. Migration locking waits behind a live owner for arbitrarily large supported migrations and recovers only a provably dead or grace-expired malformed owner.
- Canonical legacy-message validation includes only proven migration-era writer variants: unscoped message-level provider-specific fields and defined JSON-valued tool responses are preserved without normalization. This compatibility does not change current message types or admit missing tool responses, malformed provider metadata, non-object function-call arguments, or relaxed record identity/role checks.
- The manifest audits torn physical prefixes, unique recovered logical records, inserted missing SQLite rows, and per-source recovered identities/payload hashes. This audit does not rewrite the raw backup source.
- Legacy archive and LLM-journal JSONL scanning uses the shared LF/CRLF UTF-8 framing contract in [src-jsonl](./src-jsonl.md), preserving literal U+2028/U+2029 inside JSON strings and failing before migration completion or source movement on invalid records.
- Each legacy frontier file maps to a session id by stripping `.frontier.json` from its path relative to `state/sessions`.
- For a matching session history JSON, the migration reads legacy `{ frontier, nextBlockId }`, keeps the existing `history` byte-semantically authoritative, removes any obsolete embedded `contextFrontier`, advances `nextBlockId` to at least the legacy/block-ID floor, verifies that current history remains present and no embedded frontier was written, then moves the standalone file under `state/migration-backup/<migration-id>/...`.
- If a frontier file is corrupt or missing its session history, the migration logs a warning, records the failure, and leaves the original file in place. A well-formed but unmatched legacy frontier is still retirement input; it does not block migration or rewrite active history.
- Runtime session load does not fallback-read leftover failed frontier files; resolving those files requires a future explicit repair/manual migration path.

## Design Decisions

- [2026-06-17] Use `state/migrationVersion.json` as a reusable migration-version registry to avoid repeated startup scans. Successful frontier migration moves legacy files to `state/migration-backup/<migration-id>/...`; failed files are never deleted automatically.
- [2026-06-17] Legacy frontier parsing, payload normalization, and standalone frontier file movement belong in `src/migrations/`, not in current layered-context/session runtime modules.
- [2026-08-13] Current runtime ignores both embedded `contextFrontier` and standalone `*.frontier.json`; they are compatibility/retirement inputs only. Canonical authority: [D-context-active-history-authority](../threads/context-compaction-and-recall.md#d-context-active-history-authority).
### D-legacy-undated-exec-artifact-migration

Legacy undated persistent-exec artifacts are migrated conservatively: only exact historical wrapper/user/paths names older than a full local-day boundary are archived per agent before unlink, and the migration records completion only after none remain. The current writer's date-co-located artifact contract is owned by [D-persistent-exec-date-co-located-artifacts](./shared-persistent-exec.md#d-persistent-exec-date-co-located-artifacts).

## Integration

- `sessionManager.loadSessions()` imports `runStartupMigrations()` from `src/migrations/index.ts`.
- The migration uses `metadataStore.createSessionHistoryStore` for atomic per-session history writes.
- Tests cover migration success, backup movement, migrationVersion skip behavior, failure recording, and runtime non-fallback behavior in `src/session/sessionEmbeddedFrontierLoad.test.ts`.
- SQLite-only migration integration tests also cover literal Unicode separators, malformed-source retry behavior, and the rule that a failed Journal import does not advance its imported byte offset.
