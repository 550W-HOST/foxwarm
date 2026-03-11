import fs from 'fs-extra';
import path from 'path';
import { Message, Session } from './types';
import { logger } from './common';
import { SESSIONS_DIR, SESSIONS_FILE } from './config';

export function stripSessionMetadataForSave(session: Session): Omit<Session, 'history' | 'persistentMemorySnapshot' | 'broadcast'> {
  const { history, persistentMemorySnapshot, broadcast, ...metadata } = session;
  return metadata;
}

export function getSessionsMetadataBackupPath(index: number): string {
  return `${SESSIONS_FILE}.${index}.bak`;
}

export function getSessionHistoryFilePath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

export function getSessionsMetadataCandidatePaths(): string[] {
  return [
    SESSIONS_FILE,
    ...Array.from({ length: 5 }, (_, i) => getSessionsMetadataBackupPath(i + 1)),
    `${SESSIONS_FILE}.bak`,
  ];
}

export async function readSessionsMetadataSnapshotFromFile(filePath: string): Promise<any | null> {
  if (!await fs.pathExists(filePath)) {
    return null;
  }

  const data = await fs.readJson(filePath);
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid sessions metadata payload in ${filePath}`);
  }

  const sessionsData = data.sessions || data;
  if (!sessionsData || typeof sessionsData !== 'object') {
    throw new Error(`Invalid sessions metadata object in ${filePath}`);
  }

  return data.sessions ? data : { sessions: sessionsData };
}

export async function collectSessionHistoryFiles(dir: string): Promise<string[]> {
  if (!await fs.pathExists(dir)) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSessionHistoryFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

export function deriveSessionIdFromHistoryFile(historyFilePath: string): string {
  return path.relative(SESSIONS_DIR, historyFilePath).replace(/\.json$/, '').split(path.sep).join('/');
}

export function inferSessionLastMessageTime(history: Message[], historyFilePath: string): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const timestamp = history[i]?.__meta?.timestamp;
    if (typeof timestamp === 'number' && !Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  try {
    return fs.statSync(historyFilePath).mtimeMs;
  } catch {
    return Date.now();
  }
}

export async function rebuildSessionsMetadataFromHistoryFiles(): Promise<any> {
  const data: any = { sessions: {} };
  const historyFiles = await collectSessionHistoryFiles(SESSIONS_DIR);

  for (const historyFilePath of historyFiles) {
    try {
      const historyData = await fs.readJson(historyFilePath);
      const sessionId = deriveSessionIdFromHistoryFile(historyFilePath);
      const history = Array.isArray(historyData.history) ? historyData.history : [];
      const inferredAgent = historyData.agent || (sessionId.includes('/') ? sessionId.split('/').slice(0, -1).join('/') : 'main');
      const inferredNextSeq = typeof historyData.nextMessageSeq === 'number'
        ? historyData.nextMessageSeq
        : Math.max(0, ...history.map((message: Message) => message?.__meta?.seq || 0)) + 1;

      data.sessions[sessionId] = {
        id: sessionId,
        busy: historyData.busy ?? false,
        queue: historyData.queue || [],
        meta: {
          lastMessageTime: inferSessionLastMessageTime(history, historyFilePath),
          messageCount: history.length,
        },
        stats: {
          totalCachedTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          lastUsage: null,
        },
        currentNode: historyData.currentNode || 'master',
        agent: inferredAgent,
        nextMessageSeq: inferredNextSeq > 0 ? inferredNextSeq : 1,
        historyVersion: historyData.historyVersion ?? 0,
        parentSessionId: historyData.parentSessionId,
        displayName: historyData.displayName,
        isolated: historyData.isolated,
        model: historyData.model,
        verbose: historyData.verbose,
        aliases: historyData.aliases,
        indexingState: historyData.indexingState,
      };
    } catch (e) {
      logger.warn({ err: e, historyFilePath }, 'Failed to rebuild session metadata from history file');
    }
  }

  return data;
}

export async function loadSessionsMetadataSnapshot(): Promise<{ data: any; source: string }> {
  for (const candidatePath of getSessionsMetadataCandidatePaths()) {
    try {
      const data = await readSessionsMetadataSnapshotFromFile(candidatePath);
      if (data) {
        return { data, source: candidatePath };
      }
    } catch (e) {
      logger.warn({ err: e, candidatePath }, 'Failed to read sessions metadata candidate');
    }
  }

  const rebuilt = await rebuildSessionsMetadataFromHistoryFiles();
  return { data: rebuilt, source: 'rebuild' };
}

export async function writeSessionsMetadataAtomically(data: any): Promise<void> {
  await fs.ensureDir(path.dirname(SESSIONS_FILE));
  const tempFile = `${SESSIONS_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeJson(tempFile, data, { spaces: 2 });

  if (await fs.pathExists(SESSIONS_FILE)) {
    try {
      for (let i = 5; i >= 2; i--) {
        const prevBackup = getSessionsMetadataBackupPath(i - 1);
        const nextBackup = getSessionsMetadataBackupPath(i);
        if (await fs.pathExists(prevBackup)) {
          await fs.move(prevBackup, nextBackup, { overwrite: true });
        }
      }
      await fs.copy(SESSIONS_FILE, getSessionsMetadataBackupPath(1), { overwrite: true });
      await fs.copy(SESSIONS_FILE, `${SESSIONS_FILE}.bak`, { overwrite: true });
    } catch (e) {
      logger.warn({ err: e }, 'Failed to rotate sessions metadata backups');
    }
  }

  await fs.move(tempFile, SESSIONS_FILE, { overwrite: true });
}