import { runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';

export type StartupMigrationResult = Awaited<ReturnType<typeof runEmbeddedContextFrontierMigration>>;

export async function runStartupMigrations(): Promise<StartupMigrationResult[]> {
  const embeddedContextFrontier = await runEmbeddedContextFrontierMigration();
  return [embeddedContextFrontier];
}

export { runEmbeddedContextFrontierMigration } from './embeddedContextFrontier';
export { createMigrationVersionStore, MIGRATION_BACKUP_DIR, MIGRATION_VERSION_FILE, readMigrationVersionState } from './state';
