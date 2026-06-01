import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './common';
import { AGENTS_DIR, LOGS_DIR } from './config';

const execFileAsync = promisify(execFile);

export function formatDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatTime(date: Date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}${mm}${ss}${ms}`;
}

export async function getDatedLogPath(baseDir: string, fileName: string, date: Date = new Date()): Promise<string> {
  const dateDir = path.join(baseDir, formatDate(date));
  await fs.ensureDir(dateDir);
  return path.join(dateDir, fileName);
}

async function pruneDirectoryToMaxFiles(dir: string, maxFiles: number): Promise<void> {
  await fs.ensureDir(dir);

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile());
  if (files.length < maxFiles) {
    return;
  }

  const filesWithStat = await Promise.all(files.map(async file => {
    const fullPath = path.join(dir, file.name);
    try {
      const stat = await fs.stat(fullPath);
      return {
        fullPath,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }));

  const removableFiles = filesWithStat
    .filter((file): file is { fullPath: string; mtimeMs: number } => Boolean(file))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  while (removableFiles.length >= maxFiles) {
    const oldest = removableFiles.shift();
    if (!oldest) break;
    try {
      await fs.remove(oldest.fullPath);
    } catch {
      // Ignore delete failures here; race-condition cleanup is best effort only.
    }
  }
}

export async function getRecentLogPath(baseDir: string, fileName: string, maxFiles = 20): Promise<string> {
  const recentDir = path.join(baseDir, 'recent');
  await pruneDirectoryToMaxFiles(recentDir, maxFiles);
  return path.join(recentDir, fileName);
}

export async function moveLogsToDateErrorDir(baseDir: string, filePaths: string[], date: Date = new Date()): Promise<void> {
  const errorDir = path.join(baseDir, `${formatDate(date)}-error`);
  await fs.ensureDir(errorDir);

  for (const filePath of filePaths) {
    if (!filePath) continue;
    if (!await fs.pathExists(filePath)) continue;
    try {
      await fs.move(filePath, path.join(errorDir, path.basename(filePath)), { overwrite: true });
    } catch (e) {
      logger.warn({ err: e, filePath, errorDir }, 'Failed to move log file to error directory');
    }
  }
}

async function listDateDirs(baseDir: string): Promise<string[]> {
  if (!await fs.pathExists(baseDir)) return [];
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && e.name !== 'archives' && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
}

async function listArchives(archivesDir: string): Promise<string[]> {
  if (!await fs.pathExists(archivesDir)) return [];
  const entries = await fs.readdir(archivesDir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.tar.gz'))
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
}

export async function rotateDatedLogs(baseDir: string, keepDirs = 3, keepArchives = 7): Promise<void> {
  try {
    const dateDirs = await listDateDirs(baseDir);
    if (dateDirs.length > keepDirs) {
      const toArchive = dateDirs.slice(keepDirs);
      const archivesDir = path.join(baseDir, 'archives');
      await fs.ensureDir(archivesDir);

      for (const date of toArchive) {
        const archivePath = path.join(archivesDir, `${date}.tar.gz`);
        try {
          await execFileAsync('tar', ['-czf', archivePath, date], { cwd: baseDir });
        } catch (e) {
          logger.error({ err: e, baseDir, date }, 'Failed to archive logs');
          continue;
        }
        await fs.remove(path.join(baseDir, date));
      }
    }

    const archivesDir = path.join(baseDir, 'archives');
    const archives = await listArchives(archivesDir);
    if (archives.length > keepArchives) {
      const toRemove = archives.slice(keepArchives);
      for (const file of toRemove) {
        await fs.remove(path.join(archivesDir, file));
      }
    }
  } catch (e) {
    logger.error({ err: e, baseDir }, 'Failed to rotate logs');
  }
}

export async function rotateExecLogsForAgents(): Promise<void> {
  try {
    if (!await fs.pathExists(AGENTS_DIR)) return;
    const agents = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of agents) {
      if (!entry.isDirectory()) continue;
      const execDir = path.join(AGENTS_DIR, entry.name, '.temp', 'exec');
      await rotateDatedLogs(execDir);
    }
  } catch (e) {
    logger.error({ err: e }, 'Failed to rotate exec logs');
  }
}

export async function runLogRotation(): Promise<void> {
  await rotateDatedLogs(LOGS_DIR);
  await rotateExecLogsForAgents();
}

export function scheduleLogRotation(): void {
  runLogRotation().catch(() => {});
  const interval = 10 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    runLogRotation().catch(() => {});
  }, interval);
  timer.unref?.();
}
