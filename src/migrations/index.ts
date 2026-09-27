import { runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';
import { runLegacyUndatedExecArtifactMigration } from './legacyUndatedExecArtifacts';
import { runSqliteOnlyArchivesMigration } from './sqliteOnlyArchives';

export type StartupMigrationResult =
  | Awaited<ReturnType<typeof runEmbeddedContextFrontierMigration>>
  | Awaited<ReturnType<typeof runLegacyUndatedExecArtifactMigration>>
  | Awaited<ReturnType<typeof runSqliteOnlyArchivesMigration>>;

export async function runStartupMigrations(): Promise<StartupMigrationResult[]> {
  const sqliteOnlyArchives = await runSqliteOnlyArchivesMigration();
  const embeddedContextFrontier = await runEmbeddedContextFrontierMigration();
  const legacyUndatedExecArtifacts = await runLegacyUndatedExecArtifactMigration();
  return [sqliteOnlyArchives, embeddedContextFrontier, legacyUndatedExecArtifacts];
}

export { runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';
export { runLegacyUndatedExecArtifactMigration } from './legacyUndatedExecArtifacts';
export { runSqliteOnlyArchivesMigration, SQLITE_ONLY_ARCHIVES_MIGRATION_ID } from './sqliteOnlyArchives';
export { createMigrationVersionStore, MIGRATION_BACKUP_DIR, MIGRATION_VERSION_FILE, readMigrationVersionState } from './state';
