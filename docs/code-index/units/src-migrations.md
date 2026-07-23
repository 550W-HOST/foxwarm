# Unit: src-migrations

Files: src/migrations/index.ts, src/migrations/state.ts, src/migrations/embeddedContextFrontier.ts, src/migrations/embeddedContextFrontier.test.ts

## Purpose

Holds startup migration orchestration and migration-only data structures. Current runtime modules should stay clean: legacy formats such as standalone `*.frontier.json` are parsed here, converted into current session history JSON shape, and then moved out of the active state tree.

## Key Exports

- `runStartupMigrations()` — runs registered startup migrations and returns their summaries.
- `runEmbeddedContextFrontierMigration(options?)` — scans legacy frontier files unless migrationVersion says this migration already completed, embeds frontier data into matching session JSON files, annotates rendered messages, and moves successful legacy files to backup.
- `EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID` — current migration id (`embedded-context-frontier-v1`).
- `MIGRATION_VERSION_FILE` — `state/migrationVersion.json`.
- `MIGRATION_BACKUP_DIR` — `state/migration-backup`.
- `createMigrationVersionStore(filePath?)` / `readMigrationVersionState(store)` — lightweight DiskJsonData helpers for migration version state.
- Types: `MigrationVersionState`, `MigrationVersionEntry`, `EmbeddedContextFrontierMigrationResult`, `EmbeddedContextFrontierMigrationOptions`.

## Behavior

- `runStartupMigrations()` is called by `sessionManager.loadSessions()` before session metadata is loaded.
- Migration version state lives at `state/migrationVersion.json` and records one entry per migration id. Completed and completed-with-failures entries both prevent repeated full scans on later startup.
- The embedded context frontier migration scans `state/sessions/**/*.frontier.json` only inside `src/migrations/embeddedContextFrontier.ts`.
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

## Integration

- `sessionManager.loadSessions()` imports `runStartupMigrations()` from `src/migrations/index.ts`.
- The migration uses `metadataStore.createSessionHistoryStore` for atomic per-session history writes.
- The migration uses `layeredContext.annotateHistoryWithContextFrontierMetadata` to attach the same structured metadata that runtime rendering uses.
- Tests cover migration success, backup movement, migrationVersion skip behavior, failure recording, and runtime non-fallback behavior in `src/session/sessionEmbeddedFrontierLoad.test.ts`.
