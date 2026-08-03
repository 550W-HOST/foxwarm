# Unit: src-migrations

Files: src/migrations/index.ts, src/migrations/state.ts, src/migrations/embeddedContextFrontier.ts, src/migrations/embeddedContextFrontier.test.ts, src/migrations/legacyUndatedExecArtifacts.ts, src/migrations/legacyUndatedExecArtifacts.test.ts, src/migrations/sqliteOnlyArchives.ts, src/migrations/sqliteOnlyArchives.test.ts

## Purpose

Holds startup migration orchestration and migration-only data structures. Current runtime modules should stay clean: legacy formats such as standalone `*.frontier.json` are parsed here, converted into current session history JSON shape, and then moved out of the active state tree.

## Key Exports

- `runStartupMigrations()` — runs registered startup migrations and returns their summaries.
- `runEmbeddedContextFrontierMigration(options?)` — scans legacy frontier files unless migrationVersion says this migration already completed, embeds frontier data into matching session JSON files, annotates rendered messages, and moves successful legacy files to backup.
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
- Each legacy frontier file maps to a session id by stripping `.frontier.json` from its path relative to `state/sessions`.
- For a matching session history JSON, the migration:
  1. reads legacy `{ frontier, nextBlockId }` from the standalone frontier file;
  2. validates that the frontier aligns with rendered `history`;
  3. annotates CTX-BLOCK rendered messages with `__meta.contextBlock` and raw preserved messages with preserved/frontier metadata;
  4. writes `contextFrontier` and max `nextBlockId` into the session JSON;
  5. verifies the embedded frontier was saved;
  6. moves the legacy file under `state/migration-backup/<migration-id>/...`, preserving a path traceable to the original `state/` relative path.
- If a frontier file is corrupt, missing its session history, missing archive block metadata, or does not match rendered history, the migration logs a warning, records the failure, and leaves the original file in place.
- Runtime session load does not fallback-read leftover failed frontier files; resolving those files requires a future explicit repair/manual migration path.

## Design Decisions

- [2026-06-17] Use `state/migrationVersion.json` as a reusable migration-version registry to avoid repeated startup scans. Successful frontier migration moves legacy files to `state/migration-backup/<migration-id>/...`; failed files are never deleted automatically.
- [2026-06-17] Legacy frontier parsing, payload normalization, and standalone frontier file movement belong in `src/migrations/`, not in current layered-context/session runtime modules.
- [2026-06-17] Current runtime assumes the migration has completed: active session load reads only embedded `contextFrontier` from per-session history JSON, while leftover `*.frontier.json` files may still be cleaned on delete/rename but are not data sources.
### D-legacy-undated-exec-artifact-migration

Legacy undated persistent-exec artifacts are migrated conservatively: only exact historical wrapper/user/paths names older than a full local-day boundary are archived per agent before unlink, and the migration records completion only after none remain. The current writer's date-co-located artifact contract is owned by [D-persistent-exec-date-co-located-artifacts](./shared-persistent-exec.md#d-persistent-exec-date-co-located-artifacts).

## Integration

- `sessionManager.loadSessions()` imports `runStartupMigrations()` from `src/migrations/index.ts`.
- The migration uses `metadataStore.createSessionHistoryStore` for atomic per-session history writes.
- The migration uses `layeredContext.annotateHistoryWithContextFrontierMetadata` to attach the same structured metadata that runtime rendering uses.
- Tests cover migration success, backup movement, migrationVersion skip behavior, failure recording, and runtime non-fallback behavior in `src/session/sessionEmbeddedFrontierLoad.test.ts`.
