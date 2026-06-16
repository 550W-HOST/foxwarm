import fs from 'fs-extra';
import path from 'path';
import { logger } from '../common';
import { SESSIONS_DIR, STATE_DIR } from '../config';
import { ContextFrontierItem } from '../types';
import { DiskJsonData } from '../utils/diskJsonData';
import {
  annotateHistoryWithContextFrontierMetadata,
  ArchiveBlockRecord,
} from '../session/layeredContext';
import {
  createSessionHistoryStore,
} from '../session/metadataStore';
import { createMigrationVersionStore, MIGRATION_BACKUP_DIR, MIGRATION_VERSION_FILE, MigrationVersionEntry, readMigrationVersionState } from './state';

export const EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID = 'embedded-context-frontier-v1';

export type EmbeddedContextFrontierMigrationResult = {
  migrationId: string;
  skippedByVersion: boolean;
  scannedFiles: number;
  migratedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  backupRoot: string;
  failures: Array<{ filePath: string; reason: string }>;
};

export type EmbeddedContextFrontierMigrationOptions = {
  stateDir?: string;
  sessionsDir?: string;
  migrationVersionFile?: string;
  migrationBackupDir?: string;
  migrationId?: string;
  readBlocksByIdRange?: (sessionId: string, startId?: number, endId?: number) => Promise<ArchiveBlockRecord[]>;
};

const FAILURE_LOG_LIMIT = 20;

type LegacyFrontierPayload = {
  v: number;
  sessionId?: string;
  nextBlockId?: number;
  frontier: ContextFrontierItem[];
};

function normalizeLegacyFrontierPayload(raw: any, filePath: string): LegacyFrontierPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid legacy layered context frontier payload in ${filePath}`);
  }

  return {
    ...raw,
    v: typeof raw.v === 'number' ? raw.v : 1,
    frontier: Array.isArray(raw.frontier) ? raw.frontier : [],
  };
}

function createLegacyFrontierStore(filePath: string): DiskJsonData<LegacyFrontierPayload> {
  return new DiskJsonData<LegacyFrontierPayload>(filePath, {
    backup: false,
    normalizeLoadedData: normalizeLegacyFrontierPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read legacy layered context frontier');
    },
  });
}

async function collectLegacyFrontierFiles(dir: string): Promise<string[]> {
  if (!await fs.pathExists(dir)) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectLegacyFrontierFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.frontier.json')) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function deriveSessionIdFromFrontierFile(frontierFilePath: string, sessionsDir: string): string {
  return path.relative(sessionsDir, frontierFilePath)
    .replace(/\.frontier\.json$/, '')
    .split(path.sep)
    .join('/');
}

function getSessionHistoryPath(sessionId: string, sessionsDir: string): string {
  return path.join(sessionsDir, `${sessionId}.json`);
}

async function findAvailableBackupPath(targetPath: string): Promise<string> {
  if (!await fs.pathExists(targetPath)) {
    return targetPath;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let index = 1;
  while (true) {
    const candidate = `${targetPath}.${stamp}.${index}.bak`;
    if (!await fs.pathExists(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

async function moveFrontierToBackup(frontierFilePath: string, stateDir: string, backupRoot: string): Promise<string> {
  const relativePath = path.relative(stateDir, frontierFilePath);
  const safeRelativePath = relativePath.startsWith('..') || path.isAbsolute(relativePath)
    ? path.basename(frontierFilePath)
    : relativePath;
  const targetPath = await findAvailableBackupPath(path.join(backupRoot, safeRelativePath));
  await fs.ensureDir(path.dirname(targetPath));
  await fs.move(frontierFilePath, targetPath, { overwrite: false });
  return targetPath;
}

async function migrateOneFrontierFile(
  frontierFilePath: string,
  options: Required<Pick<EmbeddedContextFrontierMigrationOptions, 'stateDir' | 'sessionsDir' | 'migrationBackupDir' | 'migrationId'>> & Pick<EmbeddedContextFrontierMigrationOptions, 'readBlocksByIdRange'>,
): Promise<{ migrated: boolean; skipped: boolean; backupPath?: string }> {
  const sessionId = deriveSessionIdFromFrontierFile(frontierFilePath, options.sessionsDir);
  const historyFilePath = getSessionHistoryPath(sessionId, options.sessionsDir);
  if (!await fs.pathExists(historyFilePath)) {
    throw new Error(`session history file not found for ${sessionId}`);
  }

  const frontierStore = createLegacyFrontierStore(frontierFilePath);
  const frontierData = await frontierStore.readFromPath(frontierFilePath);
  if (!frontierData || !Array.isArray(frontierData.frontier)) {
    throw new Error('invalid frontier payload');
  }

  const historyStore = createSessionHistoryStore(historyFilePath);
  const historyData = await historyStore.readFromPath(historyFilePath);
  if (!historyData || !Array.isArray(historyData.history)) {
    throw new Error('invalid session history payload');
  }

  const frontier = structuredClone(frontierData.frontier) as ContextFrontierItem[];
  const annotation = await annotateHistoryWithContextFrontierMetadata(sessionId, historyData.history, frontier, {
    readBlocksByIdRange: options.readBlocksByIdRange,
  });
  if (!annotation.matched) {
    throw new Error(`frontier did not match rendered history: ${annotation.warnings.join('; ')}`);
  }

  const nextBlockId = Math.max(
    typeof historyData.nextBlockId === 'number' ? historyData.nextBlockId : 1,
    typeof frontierData.nextBlockId === 'number' ? frontierData.nextBlockId : 1,
  );
  await historyStore.write({
    ...historyData,
    history: annotation.history,
    contextFrontier: frontier,
    nextBlockId,
  });

  const verified = await historyStore.readFromPath(historyFilePath);
  if (!Array.isArray(verified?.contextFrontier) || verified.contextFrontier.length !== frontier.length) {
    throw new Error('embedded contextFrontier verification failed after save');
  }

  const backupRoot = path.join(options.migrationBackupDir, options.migrationId);
  const backupPath = await moveFrontierToBackup(frontierFilePath, options.stateDir, backupRoot);
  return { migrated: true, skipped: false, backupPath };
}

export async function runEmbeddedContextFrontierMigration(
  options: EmbeddedContextFrontierMigrationOptions = {},
): Promise<EmbeddedContextFrontierMigrationResult> {
  const stateDir = options.stateDir || STATE_DIR;
  const sessionsDir = options.sessionsDir || SESSIONS_DIR;
  const migrationVersionFile = options.migrationVersionFile || MIGRATION_VERSION_FILE;
  const migrationBackupDir = options.migrationBackupDir || MIGRATION_BACKUP_DIR;
  const migrationId = options.migrationId || EMBEDDED_CONTEXT_FRONTIER_MIGRATION_ID;
  const backupRoot = path.join(migrationBackupDir, migrationId);
  const versionStore = createMigrationVersionStore(migrationVersionFile);
  const versionState = await readMigrationVersionState(versionStore);
  const existing = versionState.migrations[migrationId];

  if (existing?.status === 'completed' || existing?.status === 'completed_with_failures') {
    return {
      migrationId,
      skippedByVersion: true,
      scannedFiles: 0,
      migratedFiles: existing.migratedFiles || 0,
      skippedFiles: existing.skippedFiles || 0,
      failedFiles: existing.failedFiles || 0,
      backupRoot: existing.backupRoot || backupRoot,
      failures: existing.failures || [],
    };
  }

  const frontierFiles = await collectLegacyFrontierFiles(sessionsDir);
  const failures: Array<{ filePath: string; reason: string }> = [];
  let migratedFiles = 0;
  let skippedFiles = 0;

  for (const frontierFilePath of frontierFiles) {
    try {
      const result = await migrateOneFrontierFile(frontierFilePath, {
        stateDir,
        sessionsDir,
        migrationBackupDir,
        migrationId,
        readBlocksByIdRange: options.readBlocksByIdRange,
      });
      if (result.migrated) {
        migratedFiles += 1;
      } else {
        skippedFiles += 1;
      }
    } catch (err: any) {
      const reason = err?.message || String(err);
      failures.push({ filePath: frontierFilePath, reason });
      if (failures.length <= FAILURE_LOG_LIMIT) {
        logger.warn({ err, frontierFilePath }, 'Failed to migrate legacy session frontier; leaving file in place');
      } else if (failures.length === FAILURE_LOG_LIMIT + 1) {
        logger.warn({ suppressedFailureCount: frontierFiles.length - FAILURE_LOG_LIMIT }, 'Suppressing additional legacy session frontier migration failure logs; see migrationVersion state for details');
      }
    }
  }

  const entry: MigrationVersionEntry = {
    status: failures.length > 0 ? 'completed_with_failures' : 'completed',
    completedAt: Date.now(),
    migratedFiles,
    skippedFiles,
    failedFiles: failures.length,
    backupRoot,
    ...(failures.length > 0 ? { failures } : {}),
  };

  await versionStore.write({
    ...versionState,
    v: 1,
    migrations: {
      ...(versionState.migrations || {}),
      [migrationId]: entry,
    },
  });

  return {
    migrationId,
    skippedByVersion: false,
    scannedFiles: frontierFiles.length,
    migratedFiles,
    skippedFiles,
    failedFiles: failures.length,
    backupRoot,
    failures,
  };
}
