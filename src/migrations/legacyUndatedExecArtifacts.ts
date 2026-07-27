import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import { logger } from '../common';
import { AGENTS_DIR } from '../config';
import { createMigrationVersionStore, MIGRATION_VERSION_FILE, MigrationVersionEntry, readMigrationVersionState } from './state';

const execFileAsync = promisify(execFile);

export const LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID = 'legacy-undated-exec-artifacts-v1';

const LEGACY_UNDATED_EXEC_ARTIFACT_NAME = /^exec_\d{13}_[0-9a-f]{8}(?:\.command\.(?:sh|ps1)|\.user\.ps1|\.paths\.json)$/;
const FAILURE_LOG_LIMIT = 20;

type LegacyExecArtifact = {
  execDir: string;
  filePath: string;
  fileName: string;
};

type ArtifactFailure = {
  filePath: string;
  reason: string;
};

export type LegacyUndatedExecArtifactMigrationResult = {
  migrationId: string;
  skippedByVersion: boolean;
  scannedFiles: number;
  migratedFiles: number;
  deferredFiles: number;
  failedFiles: number;
  remainingFiles: number;
  archiveRoots: string[];
  failures: ArtifactFailure[];
};

export type LegacyUndatedExecArtifactMigrationOptions = {
  agentsDir?: string;
  migrationVersionFile?: string;
  migrationId?: string;
  now?: Date;
  readDirectory?: (dirPath: string) => Promise<fs.Dirent[]>;
  archiveFiles?: (execDir: string, archivePath: string, fileNames: string[]) => Promise<void>;
  unlinkFile?: (filePath: string) => Promise<void>;
};

type ArtifactCollection = {
  artifacts: LegacyExecArtifact[];
  failures: ArtifactFailure[];
};

function startOfLocalYesterday(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 1);
  return cutoff;
}

function formatArchiveTime(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}${milliseconds}`;
}

function isNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function readDirectory(dirPath: string): Promise<fs.Dirent[]> {
  return await fs.readdir(dirPath, { withFileTypes: true });
}

async function collectLegacyUndatedExecArtifacts(
  agentsDir: string,
  readDir: (dirPath: string) => Promise<fs.Dirent[]>,
): Promise<ArtifactCollection> {
  const artifacts: LegacyExecArtifact[] = [];
  const failures: ArtifactFailure[] = [];

  let agents: fs.Dirent[];
  try {
    agents = await readDir(agentsDir);
  } catch (err: any) {
    if (isNotFoundError(err)) return { artifacts, failures };
    return { artifacts, failures: [{ filePath: agentsDir, reason: err?.message || String(err) }] };
  }

  for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!agent.isDirectory()) continue;
    const execDir = path.join(agentsDir, agent.name, '.temp', 'exec');
    try {
      const entries = await readDir(execDir);
      for (const entry of entries) {
        if (!entry.isFile() || !LEGACY_UNDATED_EXEC_ARTIFACT_NAME.test(entry.name)) continue;
        artifacts.push({
          execDir,
          filePath: path.join(execDir, entry.name),
          fileName: entry.name,
        });
      }
    } catch (err: any) {
      if (isNotFoundError(err)) continue;
      failures.push({ filePath: execDir, reason: err?.message || String(err) });
    }
  }

  return { artifacts: artifacts.sort((a, b) => a.filePath.localeCompare(b.filePath)), failures };
}

async function findAvailableArchivePath(archivesDir: string, now: Date): Promise<string> {
  const prefix = `${formatArchiveTime(now)}-legacy-undated-exec-artifacts`;
  let index = 0;
  while (true) {
    const suffix = index === 0 ? '' : `-${index}`;
    const candidate = path.join(archivesDir, `${prefix}${suffix}.tar.gz`);
    if (!await fs.pathExists(candidate)) return candidate;
    index += 1;
  }
}

async function archiveFilesWithTar(execDir: string, archivePath: string, fileNames: string[]): Promise<void> {
  const tempPath = `${archivePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    await execFileAsync('tar', ['-czf', tempPath, ...fileNames], { cwd: execDir });
    await fs.link(tempPath, archivePath);
    await fs.unlink(tempPath);
  } catch (err) {
    await fs.remove(tempPath).catch(() => {});
    throw err;
  }
}

function logFailures(failures: ArtifactFailure[]): void {
  for (const failure of failures.slice(0, FAILURE_LOG_LIMIT)) {
    logger.warn({ filePath: failure.filePath, reason: failure.reason }, 'Legacy undated exec artifact migration left file in place');
  }
  if (failures.length > FAILURE_LOG_LIMIT) {
    logger.warn({ suppressedFailureCount: failures.length - FAILURE_LOG_LIMIT }, 'Suppressing additional legacy undated exec artifact migration failure logs');
  }
}

export async function runLegacyUndatedExecArtifactMigration(
  options: LegacyUndatedExecArtifactMigrationOptions = {},
): Promise<LegacyUndatedExecArtifactMigrationResult> {
  const agentsDir = options.agentsDir || AGENTS_DIR;
  const migrationVersionFile = options.migrationVersionFile || MIGRATION_VERSION_FILE;
  const migrationId = options.migrationId || LEGACY_UNDATED_EXEC_ARTIFACT_MIGRATION_ID;
  const now = options.now || new Date();
  const readDir = options.readDirectory || readDirectory;
  const versionStore = createMigrationVersionStore(migrationVersionFile);
  const versionState = await readMigrationVersionState(versionStore);
  const existing = versionState.migrations[migrationId];

  if (existing?.status === 'completed') {
    return {
      migrationId,
      skippedByVersion: true,
      scannedFiles: 0,
      migratedFiles: existing.migratedFiles || 0,
      deferredFiles: 0,
      failedFiles: existing.failedFiles || 0,
      remainingFiles: 0,
      archiveRoots: existing.archiveRoots || [],
      failures: existing.failures || [],
    };
  }

  const cutoff = startOfLocalYesterday(now).getTime();
  const initial = await collectLegacyUndatedExecArtifacts(agentsDir, readDir);
  const eligibleByExecDir = new Map<string, LegacyExecArtifact[]>();
  const failures = [...initial.failures];
  let deferredFiles = 0;
  let migratedFiles = 0;
  const archiveRoots = new Set<string>();

  for (const artifact of initial.artifacts) {
    try {
      const stat = await fs.stat(artifact.filePath);
      if (stat.mtimeMs < cutoff) {
        const files = eligibleByExecDir.get(artifact.execDir) || [];
        files.push(artifact);
        eligibleByExecDir.set(artifact.execDir, files);
      } else {
        deferredFiles += 1;
      }
    } catch (err: any) {
      failures.push({ filePath: artifact.filePath, reason: err?.message || String(err) });
    }
  }

  for (const [execDir, artifacts] of eligibleByExecDir) {
    const archivesDir = path.join(execDir, 'archives');
    const archivePath = await findAvailableArchivePath(archivesDir, now);
    try {
      await fs.ensureDir(archivesDir);
      const archiveFiles = options.archiveFiles || archiveFilesWithTar;
      await archiveFiles(execDir, archivePath, artifacts.map(artifact => artifact.fileName));
      archiveRoots.add(archivesDir);
    } catch (err: any) {
      const reason = err?.message || String(err);
      for (const artifact of artifacts) failures.push({ filePath: artifact.filePath, reason });
      continue;
    }

    for (const artifact of artifacts) {
      try {
        await (options.unlinkFile || fs.unlink)(artifact.filePath);
        migratedFiles += 1;
      } catch (err: any) {
        failures.push({ filePath: artifact.filePath, reason: err?.message || String(err) });
      }
    }
  }

  const remaining = await collectLegacyUndatedExecArtifacts(agentsDir, readDir);
  failures.push(...remaining.failures);
  logFailures(failures);
  const result: LegacyUndatedExecArtifactMigrationResult = {
    migrationId,
    skippedByVersion: false,
    scannedFiles: initial.artifacts.length,
    migratedFiles,
    deferredFiles,
    failedFiles: failures.length,
    remainingFiles: remaining.artifacts.length,
    archiveRoots: Array.from(archiveRoots).sort((a, b) => a.localeCompare(b)),
    failures,
  };

  if (result.remainingFiles === 0 && remaining.failures.length === 0) {
    const entry: MigrationVersionEntry = {
      status: 'completed',
      completedAt: Date.now(),
      migratedFiles: result.migratedFiles,
      skippedFiles: result.deferredFiles,
      failedFiles: result.failedFiles,
      archiveRoots: result.archiveRoots,
      ...(result.failures.length > 0 ? { failures: result.failures } : {}),
    };
    await versionStore.write({
      ...versionState,
      v: 1,
      migrations: {
        ...(versionState.migrations || {}),
        [migrationId]: entry,
      },
    });
  }

  return result;
}
