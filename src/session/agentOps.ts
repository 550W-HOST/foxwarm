import fs from 'fs-extra';
import path from 'path';
import * as llm from '../llm';
import { getAgentDir, getAgentMemoryDir, getSessionArchiveImagesDir, getSessionArchiveLogPath, getSessionBlockArchiveLogPath, getSessionFrontierPath, SESSIONS_DIR } from '../config';
import { Session } from '../types';
import { renameSessionArchiveStore } from './archiveStore';

interface SessionAgentOpsDeps {
  getSession: (sessionId: string) => Promise<Session>;
  getExistingSession: (sessionId: string) => Promise<Session | null>;
  createSession: (sessionId: string, sessionData: any) => Promise<void>;
  saveSession: (sessionId: string) => Promise<void>;
  saveSessionsMetadata: () => Promise<void>;
  saveChannels: () => Promise<void>;
  updateAliasCache: (aliases: string[], realId: string) => void;
  updateChildSessionParentIds: (oldParentSessionId: string, newParentSessionId: string) => Promise<string[]>;
  moveSessionArchiveIndex: (oldSessionId: string, newSessionId: string) => Promise<void>;
  getAgentMetadata: (agentName: string) => { isolated?: boolean; [key: string]: any };
  getSessionsMap: () => Map<string, Session>;
  getAttachmentsMap: () => Map<string, { sessionId: string; mode?: any }>;
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

  if (inheritMemory) {
    const sourceMemoryDir = getAgentMemoryDir(sourceAgentName);
    if (await fs.pathExists(sourceMemoryDir)) {
      await fs.copy(sourceMemoryDir, agentMemoryDir);
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
}, deps: SessionAgentOpsDeps): Promise<{ aliases: string[]; updatedChildren: string[] }> {
  const { sourceSession, sourceInputId, targetSessionId, targetAgent } = options;
  const oldRealId = sourceSession.id;

  if (await deps.getExistingSession(targetSessionId)) {
    throw new Error(`Session "${targetSessionId}" already exists.`);
  }

  const oldAliases = sourceSession.aliases || [];
  const newAliases = [...new Set([...oldAliases, oldRealId, sourceInputId])];

  sourceSession.id = targetSessionId;
  sourceSession.agent = targetAgent;
  sourceSession.aliases = newAliases;

  const sessions = deps.getSessionsMap();
  sessions.delete(oldRealId);
  sessions.set(targetSessionId, sourceSession);

  const attachments = deps.getAttachmentsMap();
  for (const [channelKey, info] of attachments.entries()) {
    if (info.sessionId === oldRealId) {
      attachments.set(channelKey, { ...info, sessionId: targetSessionId });
    }
  }

  deps.updateAliasCache(newAliases, targetSessionId);

  const oldHistoryFile = path.join(SESSIONS_DIR, `${oldRealId}.json`);
  const newHistoryFile = path.join(SESSIONS_DIR, `${targetSessionId}.json`);
  if (await fs.pathExists(oldHistoryFile)) {
    await fs.ensureDir(path.dirname(newHistoryFile));
    await fs.move(oldHistoryFile, newHistoryFile, { overwrite: true });
  }

  const oldArchiveLog = getSessionArchiveLogPath(oldRealId);
  const newArchiveLog = getSessionArchiveLogPath(targetSessionId);
  if (await fs.pathExists(oldArchiveLog)) {
    await fs.ensureDir(path.dirname(newArchiveLog));
    await fs.move(oldArchiveLog, newArchiveLog, { overwrite: true });
  }

  const oldArchiveImagesDir = getSessionArchiveImagesDir(oldRealId);
  const newArchiveImagesDir = getSessionArchiveImagesDir(targetSessionId);
  if (await fs.pathExists(oldArchiveImagesDir)) {
    await fs.ensureDir(path.dirname(newArchiveImagesDir));
    await fs.move(oldArchiveImagesDir, newArchiveImagesDir, { overwrite: true });
  }

  const oldBlockArchive = getSessionBlockArchiveLogPath(oldRealId);
  const newBlockArchive = getSessionBlockArchiveLogPath(targetSessionId);
  if (await fs.pathExists(oldBlockArchive)) {
    await fs.ensureDir(path.dirname(newBlockArchive));
    await fs.move(oldBlockArchive, newBlockArchive, { overwrite: true });
  }

  const oldFrontierFile = getSessionFrontierPath(oldRealId);
  const newFrontierFile = getSessionFrontierPath(targetSessionId);
  if (await fs.pathExists(oldFrontierFile)) {
    await fs.ensureDir(path.dirname(newFrontierFile));
    await fs.move(oldFrontierFile, newFrontierFile, { overwrite: true });
  }

  const updatedChildren = await deps.updateChildSessionParentIds(oldRealId, targetSessionId);
  await renameSessionArchiveStore(oldRealId, targetSessionId);
  await deps.moveSessionArchiveIndex(oldRealId, targetSessionId);

  await deps.saveSession(targetSessionId);
  await deps.saveSessionsMetadata();
  await deps.saveChannels();

  return { aliases: newAliases, updatedChildren };
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
  if (await deps.getExistingSession(sessionId)) {
    throw new Error(`Session "${sessionId}" already exists.`);
  }

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

  const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, systemPromptFiles });
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
    convertSessionId,
    initialMemoryFiles,
    displayName,
    currentNode,
    model,
    createMainSession = true,
  } = options;

  const sourceSession = sourceSessionId ? await deps.getSession(sourceSessionId) : undefined;
  const sourceAgentName = sourceSession?.agent || 'main';
  const { agentDir } = await initializeAgentDirectory({
    agentName,
    inheritMemory,
    sourceAgentName,
    initialMemoryFiles,
  });

  if (convertSessionId && !createMainSession) {
    throw new Error('convertSessionId requires createMainSession=true.');
  }

  const mainSessionId = buildSessionId(agentName, 'main');
  const targetAgentMeta = deps.getAgentMetadata(agentName);
  const isolatedNode = targetAgentMeta.isolated && typeof targetAgentMeta.isolatedNode === 'string' && targetAgentMeta.isolatedNode.trim()
    ? targetAgentMeta.isolatedNode.trim()
    : undefined;

  if (convertSessionId) {
    const sourceToConvert = await deps.getExistingSession(convertSessionId);
    if (!sourceToConvert) {
      throw new Error(`Session "${convertSessionId}" not found.`);
    }

    if (displayName !== undefined) {
      sourceToConvert.displayName = displayName;
    }

    const oldSessionId = sourceToConvert.id;
    const { aliases, updatedChildren } = await renameSessionIdentity({
      sourceSession: sourceToConvert,
      sourceInputId: convertSessionId,
      targetSessionId: mainSessionId,
      targetAgent: agentName,
    }, deps);

    return {
      agentDir,
      mainSessionId,
      convertedFromSessionId: oldSessionId,
      aliases,
      updatedChildren,
      createdMainSession: true,
    };
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

  const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName });
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

    await initializeAgentDirectory({
      agentName: newAgentName,
      inheritMemory: createAgentInheritMemory,
      sourceAgentName: sourceSession.agent || 'main',
    });

    targetAgent = newAgentName;
    targetSessionId = `${newAgentName}/${newSessionId || 'main'}`;
    createdAgent = true;
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

  const sourceAgentName = sourceSession.agent || 'main';
  const sourceAgentMeta = deps.getAgentMetadata(sourceAgentName);
  const targetAgentMeta = deps.getAgentMetadata(targetAgent);

  if (sourceAgentMeta.isolated && sourceAgentName !== targetAgent) {
    throw new Error(`Agent "${sourceAgentName}" is isolated and cannot move sessions to other agents.`);
  }

  if (targetAgentMeta.isolated && sourceAgentName !== targetAgent) {
    throw new Error(`Agent "${targetAgent}" is isolated and cannot accept sessions from other agents.`);
  }

  const { aliases, updatedChildren } = await renameSessionIdentity({
    sourceSession,
    sourceInputId: sourceSessionId,
    targetSessionId,
    targetAgent,
  }, deps);

  return {
    oldSessionId: oldRealId,
    targetSessionId,
    targetAgent,
    createdAgent,
    aliases,
    updatedChildren,
  };
}
