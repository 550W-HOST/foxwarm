import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { promises as nodeFs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ARCHIVE_DB_PATH, STATE_DIR } from '../config';
import { logger } from '../common';
import { hasArchiveStoreSqliteAuthority, markArchiveStoreSqliteAuthority, migrateLegacySessionArchivesToSqlite, type LegacyArchiveMigrationSource } from '../session/archiveStore';
import { hasLlmJournalSqliteAuthority, markLlmJournalSqliteAuthority, migrateLegacyLlmRequestJournalToSqlite, type LegacyLlmJournalMigrationSource } from '../llmRequestJournal';
import { createMigrationVersionStore, MIGRATION_BACKUP_DIR, readMigrationVersionState } from './state';

export const SQLITE_ONLY_ARCHIVES_MIGRATION_ID = 'sqlite-only-large-archives-v1';
const LOCK_PATH = path.join(STATE_DIR, `${SQLITE_ONLY_ARCHIVES_MIGRATION_ID}.lock`);

type Source = (LegacyArchiveMigrationSource | LegacyLlmJournalMigrationSource) & { kind?: 'messages' | 'blocks' };
type ManifestFile = Omit<Source, 'filePath'> & { moved: boolean };
type Manifest = { v: 1; migrationId: string; createdAt: number; completedAt?: number; files: ManifestFile[] };

export type SqliteOnlyArchivesMigrationResult = {
  migrationId: typeof SQLITE_ONLY_ARCHIVES_MIGRATION_ID;
  skippedByVersion: boolean;
  migratedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  backupRoot?: string;
  failures?: Array<{ filePath: string; reason: string }>;
};

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function writeManifest(filePath: string, manifest: Manifest): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.tmp`;
  const handle = await nodeFs.open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await nodeFs.rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await nodeFs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function resolveContained(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) throw new Error(`Unsafe migration relative path: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Migration path escapes its data root: ${relativePath}`);
  return resolved;
}

async function moveDurably(source: string, destination: string): Promise<void> {
  await fs.ensureDir(path.dirname(destination));
  await fs.move(source, destination, { overwrite: false });
  await syncDirectory(path.dirname(source));
  if (path.dirname(source) !== path.dirname(destination)) await syncDirectory(path.dirname(destination));
}

async function restoreInterruptedMoves(manifestPath: string, backupRoot: string): Promise<void> {
  if (!await fs.pathExists(manifestPath)) return;
  const manifest = await fs.readJson(manifestPath) as Manifest;
  if (manifest?.v !== 1 || manifest.migrationId !== SQLITE_ONLY_ARCHIVES_MIGRATION_ID || !Array.isArray(manifest.files)) {
    throw new Error('Invalid SQLite-only archive migration manifest');
  }
  for (const entry of manifest.files) {
    const sourcePath = resolveContained(STATE_DIR, entry.relativeStatePath);
    const backupPath = resolveContained(backupRoot, entry.relativeStatePath);
    const sourceExists = await fs.pathExists(sourcePath);
    const backupExists = await fs.pathExists(backupPath);
    if (!sourceExists && !backupExists) throw new Error(`Migration source and backup are both missing: ${entry.relativeStatePath}`);
    if (backupExists && await hashFile(backupPath) !== entry.sha256) throw new Error(`Migration backup hash mismatch: ${entry.relativeStatePath}`);
    if (!sourceExists && backupExists) {
      await moveDurably(backupPath, sourcePath);
    } else if (sourceExists && backupExists) {
      if (await hashFile(sourcePath) !== entry.sha256) throw new Error(`Migration source hash mismatch: ${entry.relativeStatePath}`);
      await fs.remove(backupPath);
      await syncDirectory(path.dirname(backupPath));
    }
  }
}

async function acquireLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.ensureDir(STATE_DIR);
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | null = null;
  while (!handle) {
    try {
      handle = await nodeFs.open(LOCK_PATH, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    } catch (error: any) {
      if (handle) { await handle.close().catch((): void => {}); handle = null; }
      if (error?.code !== 'EEXIST') throw error;
      const owner = await nodeFs.readFile(LOCK_PATH, 'utf8').then(text => JSON.parse(text)).catch((): null => null);
      let alive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; } catch (ownerError: any) { if (ownerError?.code === 'EPERM') alive = true; }
      }
      if (!alive) {
        const stat = await nodeFs.stat(LOCK_PATH).catch((): null => null);
        // A valid dead PID proves staleness. A malformed/empty owner may only
        // be the tiny interval between O_EXCL creation and owner write, so
        // recover it only after a grace period.
        if (Number.isInteger(owner?.pid) || (stat && Date.now() - stat.mtimeMs >= 30_000)) await nodeFs.unlink(LOCK_PATH).catch((): void => {});
      }
      // A live owner can legitimately spend longer than any fixed deadline
      // validating and moving a large archive. Serialize behind it.
      await sleep(25);
    }
  }
  try { return await fn(); }
  finally { await handle.close().catch((): void => {}); await nodeFs.unlink(LOCK_PATH).catch((): void => {}); }
}

export async function runSqliteOnlyArchivesMigration(): Promise<SqliteOnlyArchivesMigrationResult> {
  return acquireLock(async () => {
    const store = createMigrationVersionStore();
    const state = await readMigrationVersionState(store);
    if (state.migrations[SQLITE_ONLY_ARCHIVES_MIGRATION_ID]?.status === 'completed') {
      if (!await fs.pathExists(ARCHIVE_DB_PATH) || !hasArchiveStoreSqliteAuthority(SQLITE_ONLY_ARCHIVES_MIGRATION_ID)
        || !hasLlmJournalSqliteAuthority(SQLITE_ONLY_ARCHIVES_MIGRATION_ID)) {
        throw new Error('SQLite-only archive migration is complete but an authoritative archive database is missing; restore the data directory backup');
      }
      return { migrationId: SQLITE_ONLY_ARCHIVES_MIGRATION_ID, skippedByVersion: true, migratedFiles: 0, skippedFiles: 0, failedFiles: 0 };
    }

    const backupRoot = path.join(MIGRATION_BACKUP_DIR, SQLITE_ONLY_ARCHIVES_MIGRATION_ID);
    const manifestPath = path.join(backupRoot, 'manifest.json');
    await restoreInterruptedMoves(manifestPath, backupRoot);

    // Both importers finish strict verification before any source is moved.
    const sessionSources = await migrateLegacySessionArchivesToSqlite();
    const llmSources = await migrateLegacyLlmRequestJournalToSqlite();
    markArchiveStoreSqliteAuthority(SQLITE_ONLY_ARCHIVES_MIGRATION_ID);
    markLlmJournalSqliteAuthority(SQLITE_ONLY_ARCHIVES_MIGRATION_ID);
    const sources: Source[] = [...sessionSources, ...llmSources];
    const files: ManifestFile[] = sources.map(({ filePath, ...source }) => {
      const expectedSourcePath = resolveContained(STATE_DIR, source.relativeStatePath);
      if (path.resolve(filePath) !== expectedSourcePath) throw new Error(`Migration source path does not match the current data root: ${source.relativeStatePath}`);
      resolveContained(backupRoot, source.relativeStatePath);
      return { ...source, moved: false };
    });
    const manifest: Manifest = { v: 1, migrationId: SQLITE_ONLY_ARCHIVES_MIGRATION_ID, createdAt: Date.now(), files };
    await writeManifest(manifestPath, manifest);

    for (const entry of manifest.files) {
      const sourcePath = resolveContained(STATE_DIR, entry.relativeStatePath);
      const backupPath = resolveContained(backupRoot, entry.relativeStatePath);
      if (await hashFile(sourcePath) !== entry.sha256) throw new Error(`Migration source changed after verification: ${entry.relativeStatePath}`);
      await moveDurably(sourcePath, backupPath);
      if (await hashFile(backupPath) !== entry.sha256) throw new Error(`Migration backup verification failed: ${entry.relativeStatePath}`);
      entry.moved = true;
      await writeManifest(manifestPath, manifest);
    }

    manifest.completedAt = Date.now();
    await writeManifest(manifestPath, manifest);
    state.migrations[SQLITE_ONLY_ARCHIVES_MIGRATION_ID] = {
      status: 'completed', completedAt: manifest.completedAt, migratedFiles: files.length, skippedFiles: 0, failedFiles: 0, backupRoot,
    };
    await store.write(state);
    logger.info({ migratedFiles: files.length, backupRoot }, 'SQLite-only archive migration completed');
    return { migrationId: SQLITE_ONLY_ARCHIVES_MIGRATION_ID, skippedByVersion: false, migratedFiles: files.length, skippedFiles: 0, failedFiles: 0, backupRoot };
  });
}
