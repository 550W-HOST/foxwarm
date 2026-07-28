import { runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';
import { runLegacyUndatedExecArtifactMigration } from './legacyUndatedExecArtifacts';

export type StartupMigrationResult =
  | Awaited<ReturnType<typeof runEmbeddedContextFrontierMigration>>
  | Awaited<ReturnType<typeof runLegacyUndatedExecArtifactMigration>>;

export async function runStartupMigrations(): Promise<StartupMigrationResult[]> {
  const embeddedContextFrontier = await runEmbeddedContextFrontierMigration();
  const legacyUndatedExecArtifacts = await runLegacyUndatedExecArtifactMigration();
  return [embeddedContextFrontier, legacyUndatedExecArtifacts];
}

export { runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';
export { runLegacyUndatedExecArtifactMigration } from './legacyUndatedExecArtifacts';
export { createMigrationVersionStore, MIGRATION_BACKUP_DIR, MIGRATION_VERSION_FILE, readMigrationVersionState } from './state';
