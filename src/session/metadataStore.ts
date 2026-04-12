import fs from 'fs-extra';
import path from 'path';
import { Message, Session } from '../types';
import { logger } from '../common';
import { SESSIONS_DIR, SESSIONS_FILE } from '../config';
import { DiskJsonData, getNumberedBackupPath } from '../utils/diskJsonData';

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
  return getNumberedBackupPath(SESSIONS_FILE, index);
}

export function getSessionHistoryFilePath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function normalizeSessionHistoryPayload(raw: any, filePath: string): Record<string, any> {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid session history payload in ${filePath}`);
  }

  return {
    ...raw,
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

export function createSessionHistoryStore(filePath: string): DiskJsonData<Record<string, any>> {
  return new DiskJsonData<Record<string, any>>(filePath, {
    backup: false,
    normalizeLoadedData: normalizeSessionHistoryPayload,
  });
}

const sessionHistoryStores = new Map<string, DiskJsonData<Record<string, any>>>();

export function getSessionHistoryStore(sessionId: string): DiskJsonData<Record<string, any>> {
  const filePath = getSessionHistoryFilePath(sessionId);
  let store = sessionHistoryStores.get(filePath);
  if (!store) {
    store = createSessionHistoryStore(filePath);
    sessionHistoryStores.set(filePath, store);
  }
  return store;
}

export async function readSessionHistorySnapshot(sessionId: string): Promise<Record<string, any> | null> {
  return getSessionHistoryStore(sessionId).readFromPath();
}

export async function writeSessionHistoryAtomically(sessionId: string, data: Record<string, any>): Promise<void> {
  await getSessionHistoryStore(sessionId).write(data);
}

export function getSessionsMetadataCandidatePaths(): string[] {
  return sessionsMetadataStore.listCandidatePaths();
}

function normalizeSessionsMetadataSnapshot(raw: any, filePath: string): any {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid sessions metadata payload in ${filePath}`);
  }

  const sessionsData = raw.sessions || raw;
  if (!sessionsData || typeof sessionsData !== 'object') {
    throw new Error(`Invalid sessions metadata object in ${filePath}`);
  }

  return raw.sessions ? raw : { sessions: sessionsData };
}

export function createSessionsMetadataStore(filePath: string = SESSIONS_FILE): DiskJsonData<any> {
  return new DiskJsonData<any>(filePath, {
    backup: {
      rotate: 5,
      includeLegacyBak: true,
      bestEffort: true,
    },
    normalizeLoadedData: normalizeSessionsMetadataSnapshot,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read sessions metadata candidate');
    },
    onBackupError: (err: unknown) => {
      logger.warn({ err }, 'Failed to rotate sessions metadata backups');
    },
  });
}

export const sessionsMetadataStore = createSessionsMetadataStore();

export async function readSessionsMetadataSnapshotFromFile(filePath: string): Promise<any | null> {
  return sessionsMetadataStore.readFromPath(filePath);
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
  const loaded = await sessionsMetadataStore.loadFirstAvailable();
  if (loaded) {
    return loaded;
  }

  const rebuilt = await rebuildSessionsMetadataFromHistoryFiles();
  return { data: rebuilt, source: 'rebuild' };
}

export async function writeSessionsMetadataAtomically(data: any): Promise<void> {
  await sessionsMetadataStore.write(data);
}