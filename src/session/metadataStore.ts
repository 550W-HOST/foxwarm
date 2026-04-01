import fs from 'fs-extra';
import path from 'path';
import { Message, Session } from '../types';
import { logger } from '../common';
import { SESSIONS_DIR, SESSIONS_FILE } from '../config';

const SESSION_HISTORY_STATE_FIELDS = [
  'queue',
  'parentSessionId',
  'systemPromptFiles',
  'indexingState',
  'historyVersion',
  'displayName',
  'currentNode',
  'cwd',
  'model',
  'childModelDefault',
  'agent',
  'verbose',
  'aliases',
  'busy',
  'busyStartedAt',
  'nextMessageSeq',
  'nextBlockId',
  'todoState',
  'compactThresholdTokens',
] as const;

const SESSION_METADATA_FIELDS = [
  'id',
  'agent',
  'aliases',
  'systemPromptFiles',
  'stats',
  'busy',
  'busyStartedAt',
  'stopping',
  'queue',
  'meta',
  'displayName',
  'archived',
  'currentNode',
  'cwd',
  'model',
  'childModelDefault',
  'verbose',
  'vectorIndexPosition',
  'indexingState',
  'historyVersion',
  'nextMessageSeq',
  'nextBlockId',
  'parentSessionId',
  'todoState',
  'compactThresholdTokens',
] as const;

function pickDefinedFields<T extends readonly string[]>(source: Record<string, any>, fields: T): Record<T[number], any> {
  const result: Record<string, any> = {};

  for (const field of fields) {
    if (source[field] !== undefined) {
      result[field] = source[field];
    }
  }

  return result as Record<T[number], any>;
}

export function serializeSessionHistoryPayload(session: Session): Record<string, any> {
  return {
    history: session.history,
    persistentMemorySnapshot: session.persistentMemorySnapshot,
    ...pickDefinedFields(session as Record<string, any>, SESSION_HISTORY_STATE_FIELDS),
  };
}

export function applySessionHistoryState(target: Session, historyData: Record<string, any>): void {
  Object.assign(target, pickDefinedFields(historyData, SESSION_HISTORY_STATE_FIELDS));

  if (target.currentNode === undefined) {
    target.currentNode = 'master';
  }

  if (!Array.isArray(target.queue)) {
    target.queue = [];
  }
}

export function stripSessionMetadataForSave(session: Session): Omit<Session, 'history' | 'persistentMemorySnapshot' | 'broadcast'> {
  return pickDefinedFields(session as Record<string, any>, SESSION_METADATA_FIELDS) as Omit<Session, 'history' | 'persistentMemorySnapshot' | 'broadcast'>;
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

export function buildRecoveredSessionMetadata(sessionId: string, historyData: Record<string, any>, history: Message[]): Record<string, any> {
  const recovered = pickDefinedFields(historyData, SESSION_METADATA_FIELDS);
  const inferredAgent = historyData.agent || (sessionId.includes('/') ? sessionId.split('/').slice(0, -1).join('/') : 'main');
  const inferredNextSeq = typeof historyData.nextMessageSeq === 'number'
    ? historyData.nextMessageSeq
    : Math.max(0, ...history.map((message: Message) => message?.__meta?.seq || 0)) + 1;

  return {
    ...recovered,
    id: sessionId,
    busy: historyData.busy ?? false,
    busyStartedAt: typeof historyData.busyStartedAt === 'number' ? historyData.busyStartedAt : undefined,
    queue: historyData.queue || [],
    meta: {
      ...(historyData.meta || {}),
      lastMessageTime: inferSessionLastMessageTime(history, getSessionHistoryFilePath(sessionId)),
      messageCount: history.length,
    },
    stats: historyData.stats || {
      totalCachedTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastUsage: null,
    },
    currentNode: historyData.currentNode || 'master',
    cwd: typeof historyData.cwd === 'string' ? historyData.cwd : undefined,
    agent: inferredAgent,
    nextMessageSeq: inferredNextSeq > 0 ? inferredNextSeq : 1,
    nextBlockId: typeof historyData.nextBlockId === 'number' && historyData.nextBlockId > 0 ? historyData.nextBlockId : 1,
    historyVersion: historyData.historyVersion ?? 0,
  };
}

export async function rebuildSessionsMetadataFromHistoryFiles(): Promise<any> {
  const data: any = { sessions: {} };
  const historyFiles = await collectSessionHistoryFiles(SESSIONS_DIR);

  for (const historyFilePath of historyFiles) {
    try {
      const historyData = await fs.readJson(historyFilePath);
      const sessionId = deriveSessionIdFromHistoryFile(historyFilePath);
      const history = Array.isArray(historyData.history) ? historyData.history : [];
      data.sessions[sessionId] = buildRecoveredSessionMetadata(sessionId, historyData, history);
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