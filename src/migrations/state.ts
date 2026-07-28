import path from 'path';
import { logger } from '../common';
import { STATE_DIR } from '../config';
import { DiskJsonData } from '../utils/diskJsonData';

export const MIGRATION_VERSION_FILE = path.join(STATE_DIR, 'migrationVersion.json');
export const MIGRATION_BACKUP_DIR = path.join(STATE_DIR, 'migration-backup');

export type MigrationStatus = 'completed' | 'completed_with_failures';

export type MigrationVersionEntry = {
  status: MigrationStatus;
  completedAt: number;
  migratedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  backupRoot?: string;
  archiveRoots?: string[];
  failures?: Array<{ filePath: string; reason: string }>;
};

export type MigrationVersionState = {
  v: 1;
  migrations: Record<string, MigrationVersionEntry>;
};

function normalizeMigrationVersionState(raw: any): MigrationVersionState {
  if (!raw || typeof raw !== 'object') {
    return { v: 1, migrations: {} };
  }

  const migrations = raw.migrations && typeof raw.migrations === 'object'
    ? raw.migrations
    : {};
  return {
    v: 1,
    migrations,
  };
}

export function createMigrationVersionStore(filePath: string = MIGRATION_VERSION_FILE): DiskJsonData<MigrationVersionState> {
  return new DiskJsonData<MigrationVersionState>(filePath, {
    backup: false,
    normalizeLoadedData: normalizeMigrationVersionState,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read migration version state');
    },
  });
}

export async function readMigrationVersionState(store: DiskJsonData<MigrationVersionState>): Promise<MigrationVersionState> {
  try {
    return await store.readFromPath() || { v: 1, migrations: {} };
  } catch (err) {
    logger.warn({ err, filePath: store.filePath }, 'Ignoring unreadable migration version state and starting fresh');
    return { v: 1, migrations: {} };
  }
}
