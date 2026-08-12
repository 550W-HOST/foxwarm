import fs from 'fs-extra';
import path from 'path';
import { isQueueItem, Message, Session } from '../types';
import { logger } from '../common';
import { SESSIONS_DIR, SESSIONS_FILE } from '../config';
import { DiskJsonData } from '../utils/diskJsonData';
import { isSessionCatalogInitialized, sessionCatalogStore } from './catalogStore';
import { CURRENT_SESSION_STATE_VERSION, normalizeAndValidateSessionAuthorityPayload } from './stateValidation';

export const SESSION_STATE_FORMAT_VERSION = CURRENT_SESSION_STATE_VERSION;

export const SESSION_HISTORY_STATE_FIELDS = [
  'queue',
  'parentSessionId',
  'promptCacheKey',
  'systemPromptFiles',
  'indexingState',
  'vectorIndexPosition',
  'historyVersion',
  'stats',
  'meta',
  'displayName',
  'currentNode',
  'cwd',
  'model',
  'effort',
  'childModelDefault',
  'childEffortDefault',
  'agent',
  'verbose',
  'aliases',
  'busy',
  'busyStartedAt',
  'stopping',
  'nextMessageSeq',
  'nextBlockId',
  'contextFrontier',
  'goalState',
  'compactThresholdTokens',
  'lastAppliedMailboxId',
] as const;

const LEGACY_CATALOG_SEEDED_STATE_FIELDS = ['stats', 'meta', 'vectorIndexPosition'] as const;
const SESSION_SEMANTIC_FIELDS = ['history', 'persistentMemorySnapshot', ...SESSION_HISTORY_STATE_FIELDS] as const;

export type SessionSemanticSnapshot = Partial<Record<(typeof SESSION_SEMANTIC_FIELDS)[number], unknown>>;

const SESSION_METADATA_FIELDS = [
  'id',
  'agent',
  'aliases',
  'systemPromptFiles',
  'stats',
  'busy',
  'busyStartedAt',
  'stopping',
  'meta',
  'displayName',
  'archived',
  'pinned',
  'sidebarOrder',
  'currentNode',
  'cwd',
  'model',
  'effort',
  'childModelDefault',
  'childEffortDefault',
  'verbose',
  'vectorIndexPosition',
  'indexingState',
  'historyVersion',
  'nextMessageSeq',
  'nextBlockId',
  'parentSessionId',
  'goalState',
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

function serializeGoalState(goalState: Session['goalState']): Session['goalState'] {
  if (!goalState || typeof goalState !== 'object') {
    return goalState;
  }

  // Older session snapshots may retain this removed setting. Keep accepting
  // them on load, but do not carry it forward into newly written snapshots.
  const { remindOnTurnEnd: _removed, ...currentGoalState } = goalState as Session['goalState'] & { remindOnTurnEnd?: unknown };
  return currentGoalState;
}

function serializeSessionStateFields(session: Session, fields: readonly string[]): Record<string, any> {
  const state = pickDefinedFields(session as Record<string, any>, fields);
  if (state.goalState !== undefined) {
    state.goalState = serializeGoalState(state.goalState);
  }
  return state;
}

export function serializeSessionHistoryPayload(session: Session): Record<string, any> {
  const state = serializeSessionStateFields(session, SESSION_HISTORY_STATE_FIELDS);
  if (state.meta && typeof state.meta === 'object') {
    const { lastChannel: _catalogOnly, ...semanticMeta } = state.meta;
    state.meta = semanticMeta;
  }
  return {
    sessionStateVersion: SESSION_STATE_FORMAT_VERSION,
    history: session.history,
    persistentMemorySnapshot: session.persistentMemorySnapshot,
    ...state,
  };
}

export function captureSessionSemanticState(session: Session): SessionSemanticSnapshot {
  const snapshot: SessionSemanticSnapshot = {};
  for (const field of SESSION_SEMANTIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(session, field)) {
      (snapshot as any)[field] = structuredClone((session as any)[field]);
    }
  }
  return snapshot;
}

/** Exact semantic restore; top-level catalog/UI fields and runtime callbacks are not enumerated or deleted. */
export function restoreSessionSemanticState(session: Session, snapshot: SessionSemanticSnapshot): void {
  for (const field of SESSION_SEMANTIC_FIELDS) delete (session as any)[field];
  for (const field of SESSION_SEMANTIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
      (session as any)[field] = structuredClone((snapshot as any)[field]);
    }
  }
}

/** Exact semantic replace followed by current-format defaults. */
export function replaceSessionSemanticState(session: Session, snapshot: SessionSemanticSnapshot): void {
  const catalogLastChannel = session.meta?.lastChannel === undefined ? undefined : structuredClone(session.meta.lastChannel);
  restoreSessionSemanticState(session, snapshot);
  if (!Array.isArray(session.history)) session.history = [];
  if (typeof session.persistentMemorySnapshot !== 'string') session.persistentMemorySnapshot = '';
  if (!session.stats || typeof session.stats !== 'object') {
    session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  }
  if (!Array.isArray(session.queue)) session.queue = [];
  session.queue = session.queue.filter(isQueueItem);
  if (!session.meta || typeof session.meta !== 'object') session.meta = { lastMessageTime: 0 };
  delete session.meta.lastChannel;
  if (catalogLastChannel !== undefined) session.meta.lastChannel = catalogLastChannel;
  if (typeof session.meta.lastMessageTime !== 'number') session.meta.lastMessageTime = 0;
  if (typeof session.busy !== 'boolean') session.busy = false;
  if (!session.currentNode) session.currentNode = 'master';
  if (!Number.isSafeInteger(session.lastAppliedMailboxId) || (session.lastAppliedMailboxId || 0) < 0) {
    session.lastAppliedMailboxId = 0;
  }
}

export function prepareSessionSemanticStateForHydration(
  catalogStub: Session,
  raw: Record<string, any>,
): { snapshot: SessionSemanticSnapshot; upgradedLegacy: boolean } {
  raw = normalizeAndValidateSessionAuthorityPayload(raw);
  const version = raw.sessionStateVersion;
  const upgradedLegacy = version === undefined;
  const source: Record<string, any> = structuredClone(raw);
  if (source.meta && typeof source.meta === 'object') delete source.meta.lastChannel;
  if (upgradedLegacy) {
    for (const field of LEGACY_CATALOG_SEEDED_STATE_FIELDS) {
      const catalogValue = (catalogStub as any)[field];
      if (!Object.prototype.hasOwnProperty.call(source, field) && catalogValue !== undefined) {
        source[field] = structuredClone(catalogValue);
      } else if ((field === 'meta' || field === 'stats') && source[field] && typeof source[field] === 'object'
        && catalogValue && typeof catalogValue === 'object') {
        source[field] = { ...structuredClone(catalogValue), ...source[field] };
      }
      if (field === 'meta' && source.meta && typeof source.meta === 'object') delete source.meta.lastChannel;
    }
  }
  const snapshot: SessionSemanticSnapshot = {};
  for (const field of SESSION_SEMANTIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) (snapshot as any)[field] = source[field];
  }
  return { snapshot, upgradedLegacy };
}

export function getSessionHistoryFilePath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function normalizeSessionHistoryPayload(raw: any, filePath: string): Record<string, any> {
  return normalizeAndValidateSessionAuthorityPayload(raw, `Session authority ${filePath}`);
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

export async function writeSessionHistoryAtomically(
  sessionId: string,
  data: Record<string, any>,
): Promise<void> {
  await getSessionHistoryStore(sessionId).write(data);
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
let sessionsMetadataWriteTail: Promise<void> = Promise.resolve();

export async function withSessionsMetadataWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = sessionsMetadataWriteTail;
  let release!: () => void;
  sessionsMetadataWriteTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
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
    if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.frontier.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

export function deriveSessionIdFromHistoryFile(historyFilePath: string): string {
  return path.relative(SESSIONS_DIR, historyFilePath).replace(/\.json$/, '').split(path.sep).join('/');
}

function inferSessionLastMessageTime(history: Message[], historyFilePath: string): number {
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
  if (isSessionCatalogInitialized()) {
    return {
      data: { sessions: Object.fromEntries(sessionCatalogStore.list().map(metadata => [metadata.id, metadata])) },
      source: sessionCatalogStore.filePath,
    };
  }
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
