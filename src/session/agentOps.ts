import fs from 'fs-extra';
import path from 'path';
import * as llm from '../llm';
import { CHANNELS_FILE, getAgentDir, getAgentMemoryDir, getSessionArchiveImagesDir, getSessionArchiveLogPath, getSessionBlockArchiveLogPath, getLegacySessionFrontierPath, SESSION_ID_MOVE_JOURNAL_PATH, SESSIONS_DIR, SESSIONS_FILE } from '../config';
import { Session } from '../types';
import { commitSessionIdRename, renameSessionArchiveStore, renameSessionArchiveStoreForRecovery } from './archiveStore';

interface SessionAgentOpsDeps {
  getSession: (sessionId: string) => Promise<Session>;
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  assertSessionIdAvailableForNewLifetime: (sessionId: string) => Promise<void>;
  createSession: (sessionId: string, sessionData: any) => Promise<void>;
  saveSession: (sessionId: string) => Promise<void>;
  saveSessionCatalogEntries: (sessionIds: string[]) => Promise<void>;
  saveChannels: () => Promise<void>;
  updateAliasCache: (aliases: string[], realId: string) => void;
  updateChildSessionParentIds: (oldParentSessionId: string, newParentSessionId: string) => Promise<string[]>;
  moveSessionArchiveIndex: (oldSessionId: string, newSessionId: string) => Promise<void>;
  getAgentMetadata: (agentName: string) => { isolated?: boolean; [key: string]: any };
  getSessionsMap: () => Map<string, Session>;
  getAttachmentsMap: () => Map<string, { sessionId: string; mode?: any }>;
  assertSessionMutationAllowed: (sessionIds: Array<string | undefined>, operation: string) => void;
}

type PendingSessionIdentityMove = {
  v: 1;
  phase: 'rolling-back' | 'finishing';
  oldSessionId: string;
  newSessionId: string;
  oldAgent?: string;
  oldAliases: string[];
  ownsTargetAgentDirectory: boolean;
  targetAgentName?: string;
  createdAt: number;
};

export class SessionMoveRollbackError extends Error {
  readonly errors: unknown[];

  constructor(message: string, errors: unknown[]) {
    super(message);
    this.name = 'SessionMoveRollbackError';
    this.errors = errors;
  }
}

let identityMoveFaultInjector: ((phase: 'before-target-persistence' | 'after-target-persistence', oldSessionId: string, newSessionId: string) => void) | null = null;
let agentDirectoryFaultInjector: ((phase: 'after-memory-directory' | 'after-memory-copy', agentName: string) => void) | null = null;

export function setIdentityMoveFaultInjectorForTests(
  injector: ((phase: 'before-target-persistence' | 'after-target-persistence', oldSessionId: string, newSessionId: string) => void) | null,
): void {
  identityMoveFaultInjector = injector;
}

export function setAgentDirectoryFaultInjectorForTests(
  injector: ((phase: 'after-memory-directory' | 'after-memory-copy', agentName: string) => void) | null,
): void {
  agentDirectoryFaultInjector = injector;
}

function buildPendingSessionIdentityMove(options: {
  sourceSession: Session;
  sourceInputId: string;
  targetSessionId: string;
  targetAgent: string;
  ownsTargetAgentDirectory: boolean;
}): PendingSessionIdentityMove {
  const { sourceSession, sourceInputId, targetSessionId, targetAgent, ownsTargetAgentDirectory } = options;
  const oldAliases = sourceSession.aliases || [];
  assertSafeJournalSessionId(sourceSession.id, 'oldSessionId');
  assertSafeJournalSessionId(sourceInputId, 'sourceInputId');
  assertSafeJournalSessionId(targetSessionId, 'newSessionId');
  for (const alias of oldAliases) assertSafeJournalSessionId(alias, 'oldAliases');
  return {
    v: 1,
    phase: 'rolling-back',
    oldSessionId: sourceSession.id,
    newSessionId: targetSessionId,
    oldAgent: sourceSession.agent,
    oldAliases: [...oldAliases],
    ownsTargetAgentDirectory,
    targetAgentName: ownsTargetAgentDirectory ? targetAgent : undefined,
    createdAt: Date.now(),
  };
}

async function writePendingSessionIdentityMove(record: PendingSessionIdentityMove): Promise<void> {
  await fs.ensureDir(path.dirname(SESSION_ID_MOVE_JOURNAL_PATH));
  const temporaryPath = `${SESSION_ID_MOVE_JOURNAL_PATH}.${process.pid}.tmp`;
  await fs.writeJson(temporaryPath, record, { spaces: 2 });
  await fs.move(temporaryPath, SESSION_ID_MOVE_JOURNAL_PATH, { overwrite: true });
}

async function clearPendingSessionIdentityMove(): Promise<void> {
  await fs.remove(SESSION_ID_MOVE_JOURNAL_PATH);
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.recovery.tmp`;
  await fs.writeJson(temporaryPath, data, { spaces: 2 });
  await fs.move(temporaryPath, filePath, { overwrite: true });
}

function assertSafeJournalSessionId(sessionId: string, fieldName: string): void {
  const segments = sessionId.split('/');
  if (!sessionId
    || path.isAbsolute(sessionId)
    || sessionId.includes('\\')
    || sessionId.includes('\0')
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid ${fieldName} in pending session identity move journal.`);
  }
}

export async function recoverPendingSessionIdentityMove(
  moveSessionArchiveIndex: (oldSessionId: string, newSessionId: string) => Promise<void>,
  catalog?: { load: () => Promise<any>; replace: (data: any) => Promise<void> },
): Promise<'none' | 'finished' | 'rolled-back'> {
  if (!await fs.pathExists(SESSION_ID_MOVE_JOURNAL_PATH)) return 'none';
  const record = await fs.readJson(SESSION_ID_MOVE_JOURNAL_PATH) as Partial<PendingSessionIdentityMove>;
  if (record.v !== 1 || typeof record.oldSessionId !== 'string' || typeof record.newSessionId !== 'string') {
    throw new Error('Invalid pending session identity move journal.');
  }
  if ((record.phase !== 'rolling-back' && record.phase !== 'finishing')
    || typeof record.ownsTargetAgentDirectory !== 'boolean'
    || !Array.isArray(record.oldAliases)
    || record.oldAliases.some(alias => typeof alias !== 'string')
    || (record.ownsTargetAgentDirectory && (typeof record.targetAgentName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(record.targetAgentName)))) {
    throw new Error('Pending session identity move journal is missing valid recovery intent or ownership metadata.');
  }
  const oldSessionId = record.oldSessionId;
  const newSessionId = record.newSessionId;
  assertSafeJournalSessionId(oldSessionId, 'oldSessionId');
  assertSafeJournalSessionId(newSessionId, 'newSessionId');
  for (const alias of record.oldAliases) assertSafeJournalSessionId(alias, 'oldAliases');
  if (record.oldAgent && !/^[a-zA-Z0-9_-]+$/.test(record.oldAgent)) {
    throw new Error('Invalid oldAgent in pending session identity move journal.');
  }
  if (record.ownsTargetAgentDirectory) {
    const targetAgentName = record.targetAgentName!;
    const targetSegments = newSessionId.split('/');
    if (targetAgentName === 'main'
      || targetSegments.length !== 2
      || targetSegments[0] !== targetAgentName
      || (record.oldAgent || 'main') === targetAgentName) {
      throw new Error('Pending session identity move journal has inconsistent target-agent directory ownership.');
    }
  } else if (record.targetAgentName !== undefined) {
    throw new Error('Pending session identity move journal names a target agent without owning its directory.');
  }
  if (oldSessionId === newSessionId) {
    throw new Error('Pending session identity move journal cannot use the same source and target ID.');
  }
  const metadata = catalog
    ? await catalog.load()
    : await fs.pathExists(SESSIONS_FILE) ? await fs.readJson(SESSIONS_FILE) : { sessions: {} };
  const sessionsData = metadata.sessions && typeof metadata.sessions === 'object' ? metadata.sessions : metadata;

  const rewriteChannels = async (from: string, to: string): Promise<void> => {
    if (!await fs.pathExists(CHANNELS_FILE)) return;
    const channelsData = await fs.readJson(CHANNELS_FILE);
    for (const config of Object.values(channelsData?.channels || {}) as any[]) {
      if (config?.sessionId === from) config.sessionId = to;
    }
    await writeJsonAtomically(CHANNELS_FILE, channelsData);
  };

  if (record.phase === 'finishing') {
    if (!Object.prototype.hasOwnProperty.call(sessionsData, newSessionId)
      || !await fs.pathExists(path.join(SESSIONS_DIR, `${newSessionId}.json`))) {
      throw new Error(`Pending finishing move is missing durable target session "${newSessionId}".`);
    }
    if (record.ownsTargetAgentDirectory && record.targetAgentName && !await fs.pathExists(getAgentDir(record.targetAgentName))) {
      throw new Error(`Pending finishing move requires missing owned target agent directory "${record.targetAgentName}".`);
    }
    await renameSessionArchiveStore(oldSessionId, newSessionId);
    await moveSessionArchiveIndex(oldSessionId, newSessionId);
    await rewriteChannels(oldSessionId, newSessionId);
    await commitSessionIdRename(oldSessionId, newSessionId);
    await clearPendingSessionIdentityMove();
    return 'finished';
  }

  const reversePath = async (oldPath: string, newPath: string): Promise<void> => {
    if (!await fs.pathExists(newPath)) return;
    await fs.ensureDir(path.dirname(oldPath));
    await fs.move(newPath, oldPath, { overwrite: true });
  };
  await reversePath(path.join(SESSIONS_DIR, `${oldSessionId}.json`), path.join(SESSIONS_DIR, `${newSessionId}.json`));
  // Compatibility only: pending identity recovery runs before the one-time
  // SQLite migration, so active legacy archives may still need reversal.
  await reversePath(getSessionArchiveLogPath(oldSessionId), getSessionArchiveLogPath(newSessionId));
  await reversePath(getSessionArchiveImagesDir(oldSessionId), getSessionArchiveImagesDir(newSessionId));
  await reversePath(getSessionBlockArchiveLogPath(oldSessionId), getSessionBlockArchiveLogPath(newSessionId));
  await reversePath(getLegacySessionFrontierPath(oldSessionId), getLegacySessionFrontierPath(newSessionId));

  if (Object.prototype.hasOwnProperty.call(sessionsData, newSessionId)) {
    const sourceMetadata = sessionsData[newSessionId];
    delete sessionsData[newSessionId];
    sourceMetadata.id = oldSessionId;
    if (record.oldAgent) sourceMetadata.agent = record.oldAgent;
    else delete sourceMetadata.agent;
    sourceMetadata.aliases = [...(record.oldAliases || [])];
    sessionsData[oldSessionId] = sourceMetadata;
  }

  for (const [sessionId, sessionMeta] of Object.entries(sessionsData) as Array<[string, any]>) {
    if (sessionMeta?.parentSessionId === newSessionId) sessionMeta.parentSessionId = oldSessionId;
    const historyPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (await fs.pathExists(historyPath)) {
      const historyData = await fs.readJson(historyPath);
      if (historyData?.parentSessionId === newSessionId) {
        historyData.parentSessionId = oldSessionId;
        await writeJsonAtomically(historyPath, historyData);
      }
    }
  }
  const restoredHistoryPath = path.join(SESSIONS_DIR, `${oldSessionId}.json`);
  if (await fs.pathExists(restoredHistoryPath)) {
    const restoredHistory = await fs.readJson(restoredHistoryPath);
    restoredHistory.id = oldSessionId;
    if (record.oldAgent) restoredHistory.agent = record.oldAgent;
    else delete restoredHistory.agent;
    restoredHistory.aliases = [...(record.oldAliases || [])];
    await writeJsonAtomically(restoredHistoryPath, restoredHistory);
  }
  if (catalog) await catalog.replace(metadata);
  else await writeJsonAtomically(SESSIONS_FILE, metadata);
  await rewriteChannels(newSessionId, oldSessionId);
  renameSessionArchiveStoreForRecovery(newSessionId, oldSessionId);
  await moveSessionArchiveIndex(newSessionId, oldSessionId);
  if (record.ownsTargetAgentDirectory && record.targetAgentName) {
    await fs.remove(getAgentDir(record.targetAgentName));
  }
  await clearPendingSessionIdentityMove();
  return 'rolled-back';
}

export function validateAgentName(agentName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentName)) {
    throw new Error('Invalid agent name. Use only alphanumeric characters, hyphens, and underscores.');
  }
}

export function validateSessionName(sessionName: string): void {
  if (!sessionName || typeof sessionName !== 'string' || sessionName.includes('/')) {
    throw new Error('Invalid session name. Session names cannot be empty or contain "/" character.');
  }
}

function buildSessionId(agentName: string, sessionName: string): string {
  return agentName === 'main' ? sessionName : `${agentName}/${sessionName}`;
}

async function initializeAgentDirectory(options: {
  agentName: string;
  inheritMemory?: boolean;
  sourceAgentName?: string;
  initialMemoryFiles?: Record<string, string>;
}): Promise<{ agentDir: string; agentMemoryDir: string }> {
  const { agentName, inheritMemory = false, sourceAgentName = 'main', initialMemoryFiles } = options;

  validateAgentName(agentName);

  const agentDir = getAgentDir(agentName);
  const agentMemoryDir = getAgentMemoryDir(agentName);

  if (await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" already exists`);
  }

  await fs.ensureDir(agentMemoryDir);
  agentDirectoryFaultInjector?.('after-memory-directory', agentName);

  if (inheritMemory) {
    const sourceMemoryDir = getAgentMemoryDir(sourceAgentName);
    if (await fs.pathExists(sourceMemoryDir)) {
      await fs.copy(sourceMemoryDir, agentMemoryDir);
      agentDirectoryFaultInjector?.('after-memory-copy', agentName);
    }
  }

  if (initialMemoryFiles) {
    for (const [fileName, content] of Object.entries(initialMemoryFiles)) {
      await fs.outputFile(path.join(agentMemoryDir, fileName), content);
    }
  }

  return { agentDir, agentMemoryDir };
}

async function renameSessionIdentity(options: {
  sourceSession: Session;
  sourceInputId: string;
  targetSessionId: string;
  targetAgent: string;
  ownsTargetAgentDirectory?: boolean;
  preparedPendingMove?: PendingSessionIdentityMove;
}, deps: SessionAgentOpsDeps): Promise<{ aliases: string[]; updatedChildren: string[] }> {
  const { sourceSession, sourceInputId, targetSessionId, targetAgent, ownsTargetAgentDirectory = false, preparedPendingMove } = options;
  const oldRealId = sourceSession.id;
  const oldAgent = sourceSession.agent;

  deps.assertSessionMutationAllowed([oldRealId], 'move or rename');
  if (!preparedPendingMove) await deps.assertSessionIdAvailableForNewLifetime(targetSessionId);

  const oldAliases = sourceSession.aliases || [];
  const newAliases = [...new Set([...oldAliases, oldRealId, sourceInputId])];
  const pendingMove = preparedPendingMove || buildPendingSessionIdentityMove({
    sourceSession,
    sourceInputId,
    targetSessionId,
    targetAgent,
    ownsTargetAgentDirectory,
  });
  if (!preparedPendingMove) await writePendingSessionIdentityMove(pendingMove);
  try {
    deps.assertSessionMutationAllowed([oldRealId], 'move or rename');
  } catch (error) {
    if (!preparedPendingMove) await clearPendingSessionIdentityMove();
    throw error;
  }
  const sessions = deps.getSessionsMap();
  const attachments = deps.getAttachmentsMap();
  const originalAttachments = new Map(
    [...attachments.entries()].filter(([, info]) => info.sessionId === oldRealId),
  );
  const movedPaths: Array<{ from: string; to: string }> = [];
  let childrenUpdated = false;
  let archiveStoreRenamed = false;
  let vectorIndexMoved = false;
  let updatedChildren: string[] = [];

  const movePath = async (from: string, to: string): Promise<void> => {
    if (!await fs.pathExists(from)) return;
    await fs.ensureDir(path.dirname(to));
    await fs.move(from, to, { overwrite: true });
    movedPaths.push({ from, to });
  };

  sourceSession.id = targetSessionId;
  sourceSession.agent = targetAgent;
  sourceSession.aliases = newAliases;
  sessions.delete(oldRealId);
  sessions.set(targetSessionId, sourceSession);
  for (const [channelKey, info] of originalAttachments) {
    attachments.set(channelKey, { ...info, sessionId: targetSessionId });
  }

  try {
    await movePath(path.join(SESSIONS_DIR, `${oldRealId}.json`), path.join(SESSIONS_DIR, `${targetSessionId}.json`));
    // Normally absent after startup migration; retained for pre-migration
    // pending-move compatibility and harmless for SQLite-only runtime.
    await movePath(getSessionArchiveLogPath(oldRealId), getSessionArchiveLogPath(targetSessionId));
    await movePath(getSessionArchiveImagesDir(oldRealId), getSessionArchiveImagesDir(targetSessionId));
    await movePath(getSessionBlockArchiveLogPath(oldRealId), getSessionBlockArchiveLogPath(targetSessionId));
    await movePath(getLegacySessionFrontierPath(oldRealId), getLegacySessionFrontierPath(targetSessionId));

    childrenUpdated = true;
    updatedChildren = await deps.updateChildSessionParentIds(oldRealId, targetSessionId);
    await renameSessionArchiveStore(oldRealId, targetSessionId);
    archiveStoreRenamed = true;
    vectorIndexMoved = true;
    await deps.moveSessionArchiveIndex(oldRealId, targetSessionId);

    identityMoveFaultInjector?.('before-target-persistence', oldRealId, targetSessionId);
    await deps.saveSession(targetSessionId);
    await deps.saveSessionCatalogEntries([oldRealId, targetSessionId]);
    await deps.saveChannels();
    pendingMove.phase = 'finishing';
    await writePendingSessionIdentityMove(pendingMove);
    identityMoveFaultInjector?.('after-target-persistence', oldRealId, targetSessionId);
    await commitSessionIdRename(oldRealId, targetSessionId);
    deps.updateAliasCache(newAliases, targetSessionId);
    await clearPendingSessionIdentityMove().catch(() => {});
    return { aliases: newAliases, updatedChildren };
  } catch (error) {
    const rollbackErrors: Error[] = [];
    const attemptRollback = async (label: string, operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (rollbackError) {
        const wrapped = new Error(`Session move rollback failed during ${label}: ${String((rollbackError as any)?.message || rollbackError)}`);
        (wrapped as any).cause = rollbackError;
        rollbackErrors.push(wrapped);
      }
    };

    if (pendingMove.phase !== 'rolling-back') {
      await attemptRollback('pending journal rollback intent', async () => {
        pendingMove.phase = 'rolling-back';
        await writePendingSessionIdentityMove(pendingMove);
      });
      if (rollbackErrors.length > 0) {
        throw new SessionMoveRollbackError(`Session move failed and rollback remains pending for "${oldRealId}".`, [error, ...rollbackErrors]);
      }
    }

    if (vectorIndexMoved) await attemptRollback('vector index restore', () => deps.moveSessionArchiveIndex(targetSessionId, oldRealId));
    if (archiveStoreRenamed) await attemptRollback('archive store restore', () => renameSessionArchiveStore(targetSessionId, oldRealId));
    if (childrenUpdated) await attemptRollback('child parent restore', async () => {
      await deps.updateChildSessionParentIds(targetSessionId, oldRealId);
    });
    for (const { from, to } of movedPaths.reverse()) {
      await attemptRollback(`path restore ${to}`, async () => {
        if (!await fs.pathExists(to)) return;
        await fs.ensureDir(path.dirname(from));
        await fs.move(to, from, { overwrite: true });
      });
    }

    sourceSession.id = oldRealId;
    sourceSession.agent = oldAgent;
    sourceSession.aliases = oldAliases;
    sessions.delete(targetSessionId);
    sessions.set(oldRealId, sourceSession);
    for (const [channelKey] of originalAttachments) attachments.set(channelKey, originalAttachments.get(channelKey)!);
    deps.updateAliasCache(oldAliases, oldRealId);
    await attemptRollback('source session persistence', () => deps.saveSession(oldRealId));
    await attemptRollback('session metadata persistence', () => deps.saveSessionCatalogEntries([oldRealId, targetSessionId]));
    await attemptRollback('channel persistence', () => deps.saveChannels());
    if (ownsTargetAgentDirectory && rollbackErrors.length === 0) {
      await attemptRollback(`target agent directory removal ${targetAgent}`, () => fs.remove(getAgentDir(targetAgent)));
    }
    if (rollbackErrors.length === 0) {
      await attemptRollback('pending journal removal', clearPendingSessionIdentityMove);
    }
    if (rollbackErrors.length > 0) {
      throw new SessionMoveRollbackError(`Session move failed and rollback remains pending for "${oldRealId}".`, [error, ...rollbackErrors]);
    }
    throw error;
  }
}

export async function createSessionInAgent(options: {
  agentName: string;
  sessionName: string;
  displayName?: string;
  currentNode?: string;
  model?: string;
  parentSessionId?: string;
  systemPromptFiles?: string[];
}, deps: SessionAgentOpsDeps): Promise<{ sessionId: string }> {
  const {
    agentName,
    sessionName,
    displayName,
    currentNode,
    model,
    parentSessionId,
    systemPromptFiles,
  } = options;

  validateAgentName(agentName);
  validateSessionName(sessionName);

  if (!await fs.pathExists(getAgentDir(agentName))) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  const sessionId = buildSessionId(agentName, sessionName);
  await deps.assertSessionIdAvailableForNewLifetime(sessionId);

  if (parentSessionId) {
    const parentSession = await deps.getExistingSession(parentSessionId);
    if (!parentSession) {
      throw new Error(`Parent session "${parentSessionId}" does not exist.`);
    }
  }

  const agentMeta = deps.getAgentMetadata(agentName);
  const isolatedNode = agentMeta.isolated && typeof agentMeta.isolatedNode === 'string' && agentMeta.isolatedNode.trim()
    ? agentMeta.isolatedNode.trim()
    : undefined;

  const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, sessionId, systemPromptFiles });
  deps.assertSessionMutationAllowed([parentSessionId], 'receive a new child session');
  await deps.createSession(sessionId, {
    id: sessionId,
    agent: agentName,
    displayName,
    history: [],
    systemPromptFiles: systemPromptFiles ? [...systemPromptFiles] : undefined,
    persistentMemorySnapshot: snapshot,
    // createSessionInAgent always creates a fresh, empty session context even
    // when a parent relation is recorded. Do not inherit the parent's cache key
    // unless the operation is an actual fork that copies the prefix/history.
    promptCacheKey: llm.generatePromptCacheKey(),
    stats: {
      totalCachedTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastUsage: null,
    },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    vectorIndexPosition: 0,
    nextMessageSeq: 1,
    parentSessionId,
    currentNode: isolatedNode || currentNode || 'master',
    model,
  });

  return { sessionId };
}

export async function createAgentWithMainSession(options: {
  agentName: string;
  inheritMemory?: boolean;
  sourceSessionId?: string;
  sourceSessionOverride?: Session;
  convertSessionId?: string;
  initialMemoryFiles?: Record<string, string>;
  displayName?: string;
  currentNode?: string;
  model?: string;
  createMainSession?: boolean;
}, deps: SessionAgentOpsDeps): Promise<{
  agentDir: string;
  mainSessionId: string;
  convertedFromSessionId?: string;
  aliases: string[];
  updatedChildren: string[];
  createdMainSession: boolean;
}> {
  const {
    agentName,
    inheritMemory = false,
    sourceSessionId,
    sourceSessionOverride,
    convertSessionId,
    initialMemoryFiles,
    displayName,
    currentNode,
    model,
    createMainSession = true,
  } = options;

  validateAgentName(agentName);

  if (convertSessionId && !createMainSession) {
    throw new Error('convertSessionId requires createMainSession=true.');
  }

  const mainSessionId = buildSessionId(agentName, 'main');
  if (createMainSession) {
    // Reject archived main-session reuse before creating the agent directory.
    // A no-main agent creates no session lifetime and remains allowed.
    await deps.assertSessionIdAvailableForNewLifetime(mainSessionId);
  }

  const sourceSession = sourceSessionOverride || (sourceSessionId ? await deps.getSession(sourceSessionId) : undefined);
  const sourceAgentName = sourceSession?.agent || 'main';
  const { agentDir } = await initializeAgentDirectory({
    agentName,
    inheritMemory,
    sourceAgentName,
    initialMemoryFiles,
  });

  const targetAgentMeta = deps.getAgentMetadata(agentName);
  const isolatedNode = targetAgentMeta.isolated && typeof targetAgentMeta.isolatedNode === 'string' && targetAgentMeta.isolatedNode.trim()
    ? targetAgentMeta.isolatedNode.trim()
    : undefined;

  if (convertSessionId) {
    let sourceToConvert: Session | null = null;
    let previousDisplayName: string | undefined;
    try {
      sourceToConvert = await deps.getExistingSession(convertSessionId);
      if (!sourceToConvert) {
        throw new Error(`Session "${convertSessionId}" not found.`);
      }

      previousDisplayName = sourceToConvert.displayName;
      if (displayName !== undefined) sourceToConvert.displayName = displayName;
      const oldSessionId = sourceToConvert.id;
      const { aliases, updatedChildren } = await renameSessionIdentity({
        sourceSession: sourceToConvert,
        sourceInputId: convertSessionId,
        targetSessionId: mainSessionId,
        targetAgent: agentName,
        ownsTargetAgentDirectory: true,
      }, deps);
      return {
        agentDir,
        mainSessionId,
        convertedFromSessionId: oldSessionId,
        aliases,
        updatedChildren,
        createdMainSession: true,
      };
    } catch (error) {
      if (sourceToConvert) sourceToConvert.displayName = previousDisplayName;
      if (!(error instanceof SessionMoveRollbackError)) await fs.remove(agentDir).catch(() => {});
      throw error;
    }
  }

  if (!createMainSession) {
    return {
      agentDir,
      mainSessionId,
      aliases: [],
      updatedChildren: [],
      createdMainSession: false,
    };
  }

  try {
    const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, sessionId: mainSessionId });
    await deps.createSession(mainSessionId, {
      id: mainSessionId,
      agent: agentName,
      displayName,
      history: [],
      persistentMemorySnapshot: snapshot,
      stats: {
        totalCachedTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastUsage: null,
      },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      vectorIndexPosition: 0,
      nextMessageSeq: 1,
      currentNode: isolatedNode || currentNode || sourceSession?.currentNode || 'master',
      model: model ?? sourceSession?.model,
    });
  } catch (error) {
    await fs.remove(agentDir).catch(() => {});
    throw error;
  }

  return {
    agentDir,
    mainSessionId,
    aliases: [],
    updatedChildren: [],
    createdMainSession: true,
  };
}

export async function moveSessionToTarget(options: {
  sourceSessionId: string;
  newSessionId?: string;
  createAgent?: boolean;
  newAgentName?: string;
  createAgentInheritMemory?: boolean;
}, deps: SessionAgentOpsDeps): Promise<{
  oldSessionId: string;
  targetSessionId: string;
  targetAgent: string;
  createdAgent: boolean;
  aliases: string[];
  updatedChildren: string[];
}> {
  const {
    sourceSessionId,
    newSessionId,
    createAgent = false,
    newAgentName,
    createAgentInheritMemory = false,
  } = options;

  const sourceSession = await deps.getExistingSession(sourceSessionId);
  if (!sourceSession) {
    throw new Error(`Session "${sourceSessionId}" not found.`);
  }

  const oldRealId = sourceSession.id;

  if (newSessionId !== undefined) {
    validateSessionName(newSessionId);
  }

  if (newAgentName !== undefined) {
    validateAgentName(newAgentName);
  }

  let targetAgent: string;
  let targetSessionId: string;
  let createdAgent = false;

  if (createAgent) {
    if (!newAgentName) {
      throw new Error('newAgentName is required when createAgent=true.');
    }

    targetAgent = newAgentName;
    targetSessionId = `${newAgentName}/${newSessionId || 'main'}`;
  } else if (newAgentName) {
    if (!await fs.pathExists(getAgentDir(newAgentName))) {
      throw new Error(`Agent "${newAgentName}" does not exist.`);
    }
    if (!newSessionId) {
      throw new Error('newSessionId is required when moving to a different agent.');
    }
    targetAgent = newAgentName;
    targetSessionId = `${newAgentName}/${newSessionId}`;
  } else {
    if (!newSessionId) {
      throw new Error('newSessionId is required for renaming.');
    }
    targetAgent = sourceSession.agent || 'main';
    targetSessionId = (targetAgent === 'main' && !sourceSessionId.includes('/'))
      ? newSessionId
      : `${targetAgent}/${newSessionId}`;
  }

  assertSafeJournalSessionId(oldRealId, 'oldSessionId');
  assertSafeJournalSessionId(sourceSessionId, 'sourceInputId');
  assertSafeJournalSessionId(targetSessionId, 'newSessionId');

  const sourceAgentName = sourceSession.agent || 'main';
  const sourceAgentMeta = deps.getAgentMetadata(sourceAgentName);
  const targetAgentMeta = deps.getAgentMetadata(targetAgent);

  if (sourceAgentMeta.isolated && sourceAgentName !== targetAgent) {
    throw new Error(`Agent "${sourceAgentName}" is isolated and cannot move sessions to other agents.`);
  }

  if (targetAgentMeta.isolated && sourceAgentName !== targetAgent) {
    throw new Error(`Agent "${targetAgent}" is isolated and cannot accept sessions from other agents.`);
  }

  let preparedPendingMove: PendingSessionIdentityMove | undefined;
  if (createAgent) {
    if (await fs.pathExists(getAgentDir(targetAgent))) {
      throw new Error(`Agent "${targetAgent}" already exists`);
    }
    await deps.assertSessionIdAvailableForNewLifetime(targetSessionId);
    preparedPendingMove = buildPendingSessionIdentityMove({
      sourceSession,
      sourceInputId: sourceSessionId,
      targetSessionId,
      targetAgent,
      ownsTargetAgentDirectory: true,
    });
    await writePendingSessionIdentityMove(preparedPendingMove);
    try {
      await initializeAgentDirectory({
        agentName: targetAgent,
        inheritMemory: createAgentInheritMemory,
        sourceAgentName,
      });
      createdAgent = true;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await fs.remove(getAgentDir(targetAgent));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length === 0) {
        try {
          await clearPendingSessionIdentityMove();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new SessionMoveRollbackError(`Target agent initialization failed and cleanup remains pending for "${targetAgent}".`, [error, ...cleanupErrors]);
      }
      throw error;
    }
  }

  try {
    const { aliases, updatedChildren } = await renameSessionIdentity({
      sourceSession,
      sourceInputId: sourceSessionId,
      targetSessionId,
      targetAgent,
      ownsTargetAgentDirectory: createdAgent,
      preparedPendingMove,
    }, deps);

    return {
      oldSessionId: oldRealId,
      targetSessionId,
      targetAgent,
      createdAgent,
      aliases,
      updatedChildren,
    };
  } catch (error) {
    if (createdAgent && !(error instanceof SessionMoveRollbackError)) {
      try {
        await fs.remove(getAgentDir(targetAgent));
        await clearPendingSessionIdentityMove();
      } catch (cleanupError) {
        throw new SessionMoveRollbackError(`Session move failed and target agent "${targetAgent}" could not be removed.`, [error, cleanupError]);
      }
    }
    throw error;
  }
}
