/**
 * Session Manager - manages sessions independently of channels
 * A session can be attached to multiple channels
 */

import fs from 'fs-extra';
import path from 'path';
import { Session, Message, MessagePart, QueueItem, TokenUsage, SessionReply } from './types';
import { logger } from './common';
import { getChannelInstance } from './channel';
import * as llm from './llm';
import { getSkillInfo, validateSkillName } from './skills';
import { estimateSessionTokens, estimateSessionRangeTokens } from './tokenCount';
import * as vector from './vector';
import { SESSIONS_FILE, SESSIONS_DIR, COMPACT_PERCENT, resolveModelConfig, AGENTS_FILE, CHANNELS_FILE, getAgentDir } from './config';
import * as sessionAgentOps from './sessionAgentOps';

// Agent metadata storage
interface AgentMetadata {
  isolated?: boolean;
  inherit?: string;
  skills?: string[];
  [key: string]: any;
}

const agentMetadata = new Map<string, AgentMetadata>();

function normalizeAgentSkills(skills: unknown): string[] | undefined {
  if (!Array.isArray(skills)) {
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawSkill of skills) {
    if (typeof rawSkill !== 'string') {
      continue;
    }

    const skillName = rawSkill.trim();
    if (!skillName) {
      continue;
    }

    try {
      validateSkillName(skillName);
    } catch (e) {
      logger.warn({ err: e, skillName }, 'Skipping invalid skill in agent metadata');
      continue;
    }

    if (seen.has(skillName)) {
      continue;
    }

    seen.add(skillName);
    normalized.push(skillName);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAgentMetadata(meta: AgentMetadata): AgentMetadata {
  const nextMeta = { ...meta };
  const normalizedSkills = normalizeAgentSkills(meta.skills);

  if (normalizedSkills) {
    nextMeta.skills = normalizedSkills;
  } else {
    delete nextMeta.skills;
  }

  return nextMeta;
}

function systemPart(system: string): MessagePart {
  return { system };
}

/**
 * Load agent metadata from disk
 */
async function loadAgentMetadata(): Promise<void> {
  if (await fs.pathExists(AGENTS_FILE)) {
    try {
      const data = await fs.readJson(AGENTS_FILE);
      for (const [agentName, meta] of Object.entries(data)) {
        agentMetadata.set(agentName, normalizeAgentMetadata(meta as AgentMetadata));
      }
      logger.info({ count: agentMetadata.size }, 'Agent metadata loaded');
    } catch (e) {
      logger.error({ err: e }, 'Failed to load agent metadata');
    }
  }
}

/**
 * Save agent metadata to disk
 */
async function saveAgentMetadata(): Promise<void> {
  const data: Record<string, AgentMetadata> = {};
  for (const [agentName, meta] of agentMetadata.entries()) {
    data[agentName] = meta;
  }
  await fs.writeJson(AGENTS_FILE, data, { spaces: 2 });
}

/**
 * Get agent metadata
 */
export function getAgentMetadata(agentName: string): AgentMetadata {
  return agentMetadata.get(agentName) || {};
}

/**
 * Set agent metadata
 */
export async function setAgentMetadata(agentName: string, meta: AgentMetadata): Promise<void> {
  agentMetadata.set(agentName, normalizeAgentMetadata(meta));
  await saveAgentMetadata();
}

export function getAgentSkills(agentName: string): string[] {
  return [...(getAgentMetadata(agentName).skills || [])];
}

async function refreshDirectAgentSessions(agentName: string): Promise<string[]> {
  const affectedSessions: string[] = [];

  for (const [sessionId, sessionMeta] of sessions.entries()) {
    const sessionAgent = sessionMeta.agent || 'main';
    if (sessionAgent !== agentName) {
      continue;
    }

    const session = await getSession(sessionId);
    session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
    await saveSession(sessionId);
    affectedSessions.push(sessionId);
  }

  return affectedSessions;
}

export function getAgentInheritanceChain(agentName: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = agentName;

  while (current) {
    if (seen.has(current)) {
      logger.warn({ agentName, current, chain }, 'Circular agent inheritance detected, stopping at first repeat');
      break;
    }

    seen.add(current);
    chain.unshift(current);
    current = getAgentMetadata(current).inherit;
  }

  return chain;
}

export async function setAgentInherit(agentName: string, inheritAgentName?: string): Promise<{ affectedSessions: string[] }> {
  validateAgentName(agentName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  if (inheritAgentName) {
    validateAgentName(inheritAgentName);
    if (inheritAgentName === agentName) {
      throw new Error('Agent cannot inherit from itself.');
    }

    const inheritAgentDir = getAgentDir(inheritAgentName);
    if (!await fs.pathExists(inheritAgentDir)) {
      throw new Error(`Inherited agent "${inheritAgentName}" does not exist.`);
    }

    const parentChain = getAgentInheritanceChain(inheritAgentName);
    if (parentChain.includes(agentName)) {
      throw new Error(`Circular inheritance detected: "${agentName}" already appears in "${inheritAgentName}" inherit chain.`);
    }
  }

  const currentMeta = getAgentMetadata(agentName);
  const nextMeta = { ...currentMeta };
  if (inheritAgentName) {
    nextMeta.inherit = inheritAgentName;
  } else {
    delete nextMeta.inherit;
  }
  await setAgentMetadata(agentName, nextMeta);

  const affectedSessions: string[] = [];
  for (const [sessionId, sessionMeta] of sessions.entries()) {
    const sessionAgent = sessionMeta.agent || 'main';
    if (!getAgentInheritanceChain(sessionAgent).includes(agentName)) {
      continue;
    }

    const session = await getSession(sessionId);
    session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
    await saveSession(sessionId);
    affectedSessions.push(sessionId);
  }

  return { affectedSessions };
}

export async function attachAgentSkill(agentName: string, skillName: string): Promise<{ skills: string[]; affectedSessions: string[]; changed: boolean }> {
  validateAgentName(agentName);
  validateSkillName(skillName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  await getSkillInfo(skillName);

  const currentMeta = getAgentMetadata(agentName);
  const currentSkills = getAgentSkills(agentName);
  if (currentSkills.includes(skillName)) {
    return { skills: currentSkills, affectedSessions: [], changed: false };
  }

  const nextSkills = [...currentSkills, skillName];
  await setAgentMetadata(agentName, { ...currentMeta, skills: nextSkills });
  const affectedSessions = await refreshDirectAgentSessions(agentName);

  return { skills: nextSkills, affectedSessions, changed: true };
}

export async function detachAgentSkill(agentName: string, skillName: string): Promise<{ skills: string[]; affectedSessions: string[]; changed: boolean }> {
  validateAgentName(agentName);
  validateSkillName(skillName);

  const agentDir = getAgentDir(agentName);
  if (!await fs.pathExists(agentDir)) {
    throw new Error(`Agent "${agentName}" does not exist.`);
  }

  const currentMeta = getAgentMetadata(agentName);
  const currentSkills = getAgentSkills(agentName);
  const nextSkills = currentSkills.filter(existingSkill => existingSkill !== skillName);

  if (nextSkills.length === currentSkills.length) {
    return { skills: currentSkills, affectedSessions: [], changed: false };
  }

  await setAgentMetadata(agentName, { ...currentMeta, skills: nextSkills });
  const affectedSessions = await refreshDirectAgentSessions(agentName);

  return { skills: nextSkills, affectedSessions, changed: true };
}

// Session storage: sessionId -> Session
const sessions = new Map<string, Session>();

// Alias resolution cache: alias -> real sessionId
const aliasCache = new Map<string, string>();

export function updateAliasCache(aliases: string[], realId: string) {
  for (const alias of aliases) {
    aliasCache.set(alias, realId);
  }
}

export function removeAliasCacheEntry(alias: string) {
  aliasCache.delete(alias);
}

/**
 * Resolve session ID from alias if needed
 * Returns the real session ID or the input if not an alias
 */
async function resolveSessionId(sessionId: string): Promise<string> {
  // Check cache first
  if (aliasCache.has(sessionId)) {
    return aliasCache.get(sessionId)!;
  }

  // Check if it's already a real session
  if (sessions.has(sessionId)) {
    return sessionId;
  }

  // Search through all sessions for alias match
  for (const [realId, session] of sessions.entries()) {
    if (session.aliases?.includes(sessionId)) {
      aliasCache.set(sessionId, realId);
      return realId;
    }
  }

  // Check metadata file for aliases
  if (await fs.pathExists(SESSIONS_FILE)) {
    const data = await fs.readJson(SESSIONS_FILE);
    const sessionsData = data.sessions || data;
    
    for (const [realId, meta] of Object.entries(sessionsData)) {
      const sessionMeta = meta as any;
      if (sessionMeta.aliases?.includes(sessionId)) {
        aliasCache.set(sessionId, realId);
        return realId;
      }
    }
  }

  // Not an alias, return as-is
  return sessionId;
}

// Check if a session exists in memory or on disk (metadata)
export async function getExistingSession(sessionId: string): Promise<Session | null> {
  // Resolve alias first
  const realId = await resolveSessionId(sessionId);
  
  const session = sessions.get(realId);
  if (session) return session;

  // Check if session history file exists
  const historyFile = path.join(SESSIONS_DIR, `${realId}.json`);
  if (await fs.pathExists(historyFile)) {
    // Load metadata + history via getSession
    return await getSession(realId);
  }

  // Check metadata store
  if (await fs.pathExists(SESSIONS_FILE)) {
    const data = await fs.readJson(SESSIONS_FILE);
    const sessionsData = data.sessions || data;
    if (sessionsData[realId]) {
      return await getSession(realId);
    }
  }

  return null;
}

// Channel attachment: channelKey (platform:userId) -> { sessionId, mode }
export type ChannelMode = 'push-only' | undefined;
interface ChannelConfig { sessionId: string; mode?: ChannelMode }
const channelAttachments = new Map<string, ChannelConfig>();

// Callback to trigger agent turn
let onSessionTriggered: ((sessionId: string) => void) | null = null;

async function saveChannels(): Promise<void> {
  try {
    const data: any = { channels: {} };
    for (const [channelKey, config] of channelAttachments.entries()) {
      data.channels[channelKey] = config;
    }
    await fs.writeJson(CHANNELS_FILE, data, { spaces: 2 });
  } catch (e) {
    logger.error(e, 'Failed to save channels');
  }
}

async function loadChannels(): Promise<void> {
  if (await fs.pathExists(CHANNELS_FILE)) {
    try {
      const data = await fs.readJson(CHANNELS_FILE);
      if (data.channels) {
        for (const [channelKey, config] of Object.entries(data.channels)) {
          channelAttachments.set(channelKey, config as ChannelConfig);
        }
      }
      logger.info({ attachmentCount: channelAttachments.size }, 'Channels loaded');
    } catch (e) {
      logger.error(e, 'Failed to load channels');
    }
  }
}

// Callback when history is updated (for SSE broadcasting)
let onHistoryUpdated: ((sessionId: string, message: Message) => void) | null = null;

// Callback when session list is updated (for SSE broadcasting)
let onSessionListUpdated: (() => void) | null = null;

export function setOnHistoryUpdated(callback: (sessionId: string, message: Message) => void) {
  onHistoryUpdated = callback;
}

export function setOnSessionListUpdated(callback: () => void) {
  onSessionListUpdated = callback;
}

function makeChannelKey(platform: string, channelUserId: string): string {
  return `${platform}:${channelUserId}`;
}

export function generateSessionId(): string {
  const now = new Date();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substr(2, 5);
  return `${MM}${DD}_${random}`;
}

/**
 * Resume indexing if it was interrupted
 */
async function resumeIndexingIfNeeded(sessionId: string, session: Session): Promise<void> {
  if (!session.indexingState?.inProgress) return;
  
  const state = session.indexingState;
  const timeSinceStart = Date.now() - state.startTime;
  
  // If indexing started more than 5 minutes ago, consider it stale and restart
  if (timeSinceStart > 5 * 60 * 1000) {
    logger.warn({ sessionId, timeSinceStart }, 'Stale indexing state detected, restarting');
    session.indexingState = undefined;
    return;
  }
  
  // Check if history version matches
  if (state.historyVersion !== session.historyVersion) {
    logger.warn({ sessionId, stateVersion: state.historyVersion, currentVersion: session.historyVersion }, 
      'History version mismatch, discarding indexing state');
    session.indexingState = undefined;
    return;
  }
  
  // Check if the history has changed since indexing started
  if (state.endPosition !== session.history.length) {
    logger.info({ sessionId, oldEnd: state.endPosition, newEnd: session.history.length }, 
      'History changed during indexing, will re-index');
    session.indexingState = undefined;
    return;
  }
  
  logger.info({ sessionId, startPos: state.startPosition, endPos: state.endPosition }, 
    'Resuming interrupted indexing');
  
  // Resume indexing
  const currentVersion = session.historyVersion || 0;
  vector.indexNewMessages(sessionId, session.history, state.startPosition)
    .then(newPos => {
      // Check if history was modified during indexing
      if (session.historyVersion !== currentVersion) {
        logger.warn({ sessionId, oldVersion: currentVersion, newVersion: session.historyVersion }, 
          'History was modified during resumed indexing (compact/clear), not updating vectorIndexPosition');
        session.indexingState = undefined;
        return;
      }
      
      session.vectorIndexPosition = newPos;
      session.indexingState = undefined;
      logger.info({ sessionId, newPos }, 'Resumed indexing completed');
      saveSession(sessionId).catch(e => 
        logger.error({ err: e, sessionId }, 'Failed to save after resumed indexing')
      );
    })
    .catch(e => {
      logger.error({ err: e, sessionId }, 'Failed to resume indexing');
      session.indexingState = undefined;
    });
}

export async function getSession(sessionId: string): Promise<Session> {
  // Resolve alias first
  const realId = await resolveSessionId(sessionId);
  
  let session = sessions.get(realId);
  let isNew = false;
  if (!session) {
    // Create new session with minimal required fields
    isNew = true;
    session = {
      id: realId,
      history: [],
      persistentMemorySnapshot: '',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() }
    };
    sessions.set(realId, session);
  }

  // Session exists in memory, check if history needs to be loaded
  if (!isNew && session.history.length === 0) {
    // Try to load history and persistentMemorySnapshot from file
    const historyFile = path.join(SESSIONS_DIR, `${realId}.json`);
    if (await fs.pathExists(historyFile)) {
      try {
        const historyData = await fs.readJson(historyFile);
        session.history = historyData.history || [];
        if (historyData.persistentMemorySnapshot) {
          session.persistentMemorySnapshot = historyData.persistentMemorySnapshot;
        }
        if (historyData.parentSessionId !== undefined) {
          session.parentSessionId = historyData.parentSessionId;
        }
        if (historyData.queue !== undefined) {
          session.queue = historyData.queue;
        }
        if (historyData.historyVersion !== undefined) {
          session.historyVersion = historyData.historyVersion;
        }
        if (historyData.displayName !== undefined) {
          session.displayName = historyData.displayName;
        }
        if (historyData.indexingState) {
          session.indexingState = historyData.indexingState;
          // Check if indexing was interrupted
          await resumeIndexingIfNeeded(sessionId, session);
        }
        if (historyData.displayName !== undefined) {
          session.displayName = historyData.displayName;
        }
        if (historyData.currentNode !== undefined) {
          session.currentNode = historyData.currentNode;
        } else {
          session.currentNode = 'master';
        }
        if (historyData.isolated !== undefined) {
          session.isolated = historyData.isolated;
        }
        if (historyData.model !== undefined) {
          session.model = historyData.model;
        }
        if (historyData.agent !== undefined) {
          session.agent = historyData.agent;
        }
        if (historyData.verbose !== undefined) {
          session.verbose = historyData.verbose;
        }
        if (historyData.aliases !== undefined) {
          session.aliases = historyData.aliases;
        }
        if (historyData.busy !== undefined) {
          session.busy = historyData.busy;
        }
        logger.info({ sessionId: realId, messageCount: session.history.length }, 'Session history loaded from file');
      } catch (e) {
        logger.error({ err: e, sessionId }, 'Failed to load session history');
      }
    }
  }

  // Ensure required fields exist
  if (!session.id) session.id = realId;
  if (!session.agent) {
    // Infer agent from sessionId if it contains '/'
    if (realId.includes('/')) {
      const parts = realId.split('/');
      session.agent = parts.slice(0, -1).join('/');
    } else {
      session.agent = 'main';
    }
  }
  if (!session.persistentMemorySnapshot) session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent);
  if (!session.stats) session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  if (session.stats.totalCachedTokens === null) session.stats.totalCachedTokens = 0;
  if (!session.queue) session.queue = [];
  if (session.busy === undefined) session.busy = false;
  if (!session.meta) session.meta = { lastMessageTime: Date.now() };
  if (!session.currentNode) session.currentNode = 'master'; // Default to master node

  // Setup broadcast function
  if (!session.broadcast) {
    setupSessionBroadcast(sessionId);
  }

  return session;
}

/**
 * Create a new session with given data
 */
export async function createSession(sessionId: string, sessionData: any): Promise<void> {
  sessions.set(sessionId, sessionData);
  await saveSession(sessionId);
  logger.info({ sessionId }, 'Session created');
}

export const validateAgentName = sessionAgentOps.validateAgentName;
export const validateSessionName = sessionAgentOps.validateSessionName;

function getSessionAgentOpsDeps() {
  return {
    getSession,
    getExistingSession,
    createSession,
    saveSession,
    saveSessionsMetadata,
    saveChannels,
    updateAliasCache,
    updateChildSessionParentIds,
    getAgentMetadata,
    getSessionsMap: getAllSessions,
    getAttachmentsMap: getAllAttachments,
  };
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
  inherit?: string;
}): Promise<{
  agentDir: string;
  mainSessionId: string;
  convertedFromSessionId?: string;
  aliases: string[];
  updatedChildren: string[];
  createdMainSession: boolean;
}> {
  const { inherit, ...createOptions } = options;
  const normalizedInherit = inherit && String(inherit).trim() ? String(inherit).trim() : undefined;

  if (normalizedInherit !== undefined) {
    validateAgentName(normalizedInherit);
    if (!await fs.pathExists(getAgentDir(normalizedInherit))) {
      throw new Error(`Inherited agent "${normalizedInherit}" does not exist.`);
    }
  }

  const result = await sessionAgentOps.createAgentWithMainSession(createOptions, getSessionAgentOpsDeps());
  if (normalizedInherit !== undefined) {
    await setAgentInherit(options.agentName, normalizedInherit);
  }
  return result;
}

export async function createSessionInAgent(options: {
  agentName: string;
  sessionName: string;
  displayName?: string;
  currentNode?: string;
  model?: string;
  parentSessionId?: string;
}): Promise<{ sessionId: string }> {
  return sessionAgentOps.createSessionInAgent(options, getSessionAgentOpsDeps());
}

export async function moveSessionToTarget(options: {
  sourceSessionId: string;
  newSessionId?: string;
  createAgent?: boolean;
  newAgentName?: string;
  createAgentInheritMemory?: boolean;
}): Promise<{
  oldSessionId: string;
  targetSessionId: string;
  targetAgent: string;
  createdAgent: boolean;
  aliases: string[];
  updatedChildren: string[];
}> {
  return sessionAgentOps.moveSessionToTarget(options, getSessionAgentOpsDeps());
}

/**
 * Attach a channel to a session
 * @param platform Platform name (telegram, matrix)
 * @param channelUserId Platform-specific user ID
 * @param sessionId Optional session ID. If not provided, creates a new session
 * @returns The session ID
 */
export function attachChannel(platform: string, channelUserId: string, sessionId?: string): string {
  const channelKey = makeChannelKey(platform, channelUserId);

  if (!sessionId) {
    sessionId = generateSessionId();
  }

  channelAttachments.set(channelKey, { sessionId });
  saveChannels().catch(err => logger.error({ err }, 'Failed to save channels'));
  logger.info({ platform, channelUserId, sessionId }, 'Channel attached to session');
  return sessionId;
}

export function getSessionByChannel(platform: string, channelUserId: string): string | undefined {
  const channelKey = makeChannelKey(platform, channelUserId);
  return channelAttachments.get(channelKey)?.sessionId;
}

export function getChannelConfig(platform: string, channelUserId: string): ChannelConfig | undefined {
  const channelKey = makeChannelKey(platform, channelUserId);
  return channelAttachments.get(channelKey);
}

export function setChannelMode(platform: string, channelUserId: string, mode: ChannelMode | undefined) {
  const channelKey = makeChannelKey(platform, channelUserId);
  const existing = channelAttachments.get(channelKey);
  if (!existing) {
    throw new Error(`Channel ${channelKey} not attached`);
  }
  channelAttachments.set(channelKey, { ...existing, mode });
  saveChannels().catch(err => logger.error({ err }, 'Failed to save channels'));
}

export function detachChannel(platform: string, channelUserId: string): void {
  const channelKey = makeChannelKey(platform, channelUserId);
  channelAttachments.delete(channelKey);
  saveChannels().catch(err => logger.error({ err }, 'Failed to save channels'));
  logger.info({ platform, channelUserId }, 'Channel detached from session');
}

export async function sendToChannelById(channelId: string, message: string): Promise<void> {
  const [platform, ...rest] = channelId.split(':');
  const channelUserId = rest.join(':');
  if (!platform || !channelUserId) {
    throw new Error('Invalid channelId format. Use platform:userId');
  }
  const channel = getChannelInstance(platform);
  if (!channel) {
    throw new Error(`Channel platform "${platform}" not found`);
  }
  await channel.sendMessage(channelUserId, message);
}

/**
 * Setup broadcast function for a session
 * Broadcasts messages to all attached channels
 */
export function setupSessionBroadcast(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const broadcast: SessionReply = (text: string, options?: any) => {
    const channels = getChannelsBySession(sessionId);
    const excludePlatforms = options?.excludePlatforms || [];
    logger.debug({ sessionId, channelCount: channels.length, excludePlatforms, textPreview: text.substring(0, 50) }, 'Broadcasting message');

    for (const channelInfo of channels) {
      if (excludePlatforms.includes(channelInfo.platform)) {
        logger.debug({ platform: channelInfo.platform, channelUserId: channelInfo.channelUserId }, 'Skipping excluded platform');
        continue;
      }

      const channel = getChannelInstance(channelInfo.platform);
      if (channel) {
        logger.debug({ platform: channelInfo.platform, channelUserId: channelInfo.channelUserId }, 'Calling channel.sendMessage');
        channel.sendMessage(channelInfo.channelUserId, text, options)?.catch((e: any) => {
          logger.error({ err: e, platform: channelInfo.platform, channelUserId: channelInfo.channelUserId }, 'Failed to broadcast message');
        });
      } else {
        logger.debug({ platform: channelInfo.platform }, 'Channel instance not found');
      }
    }
  };

  session.broadcast = broadcast;
}

/**
 * Get all channels attached to a session
 */
export function getChannelsBySession(sessionId: string): Array<{ platform: string; channelUserId: string }> {
  const channels: { platform: string; channelUserId: string }[] = [];
  for (const [channelKey, info] of channelAttachments.entries()) {
    if (info.sessionId === sessionId) {
      const separatorIndex = channelKey.indexOf(':');
      if (separatorIndex === -1) continue;

      const platform = channelKey.slice(0, separatorIndex);
      const channelUserId = channelKey.slice(separatorIndex + 1);
      channels.push({ platform, channelUserId });
    }
  }
  return channels;
}

export function getChildSessionIds(parentSessionId: string): string[] {
  return Array.from(sessions.entries())
    .filter(([, session]) => session.parentSessionId === parentSessionId)
    .map(([sessionId]) => sessionId);
}

function findAttachedChannel(
  channels: Array<{ platform: string; channelUserId: string }>,
  target?: { platform: string; channelUserId: string }
): { platform: string; channelUserId: string } | undefined {
  if (!target) return undefined;
  return channels.find(channel => (
    channel.platform === target.platform &&
    channel.channelUserId === target.channelUserId
  ));
}

function parseSourceSystemPart(system?: string): { platform: string; channelUserId: string } | undefined {
  if (!system?.startsWith('FROM: ')) return undefined;

  const raw = system.slice('FROM: '.length);
  const firstColon = raw.indexOf(':');
  if (firstColon === -1) return undefined;

  const platform = raw.slice(0, firstColon);
  let channelUserId = raw.slice(firstColon + 1);

  const userInfoMatch = channelUserId.match(/^(.*)\s\([^)]*\)$/);
  if (userInfoMatch) {
    channelUserId = userInfoMatch[1];
  }

  if (!platform || !channelUserId) return undefined;
  return { platform, channelUserId };
}

export function getChannelBySession(sessionId: string): { platform: string; channelUserId: string } | undefined {
  const channels = getChannelsBySession(sessionId);

  if (channels.length === 0) return undefined;
  if (channels.length === 1) return channels[0];

  const session = sessions.get(sessionId);
  if (session) {
    const lastChannel = findAttachedChannel(channels, session.meta?.lastChannel);
    if (lastChannel) {
      return lastChannel;
    }

    if (session.history.length > 0) {
      for (let i = session.history.length - 1; i >= 0; i--) {
        const msg = session.history[i];
        if (msg.role !== 'user') continue;

        const sourcePart = msg.parts.find(part => typeof part.system === 'string' && part.system.startsWith('FROM: '));
        const parsedChannel = parseSourceSystemPart(sourcePart?.system);
        const attachedChannel = findAttachedChannel(channels, parsedChannel);
        if (attachedChannel) {
          return attachedChannel;
        }
      }
    }
  }

  return channels[0];
}

/**
 * Fork a session (create a copy with new ID)
 * @param sourceSessionId Source session ID to fork from
 * @param suffix Optional suffix for the new session ID
 * @param isChildSession Whether this is a child session (for multi-agent)
 * @returns New session ID
 */
export async function forkSession(sourceSessionId: string, suffix?: string, isChildSession: boolean = false, options?: { node?: string; isolated?: boolean }): Promise<string> {
  const sourceSession = await getSession(sourceSessionId);
  const newSessionId = suffix 
    ? `${sourceSessionId}_${suffix}`
    : generateSessionId();

  const forkedSession: Session = {
    id: newSessionId,
    history: structuredClone(sourceSession.history),
    persistentMemorySnapshot: sourceSession.persistentMemorySnapshot,
    stats: {
      totalCachedTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastUsage: null
    },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    vectorIndexPosition: sourceSession.history.length, // Inherit parent's index position to avoid re-indexing
    parentSessionId: isChildSession ? sourceSessionId : null,
    currentNode: options?.node || sourceSession.currentNode || 'master',
    isolated: options?.isolated ?? sourceSession.isolated,
    agent: sourceSession.agent,
    verbose: sourceSession.verbose,
    model: sourceSession.model
  };

  // Check if the last message is a model message with tool calls (e.g., create_child_session)
  // If so, add tool responses for all tool calls:
  // - For the tool that created this session: "Child session created: xxx"
  // - For other tools: "Pending execution in parent session"
  const lastMessage = forkedSession.history[forkedSession.history.length - 1];
  if (lastMessage && lastMessage.role === 'model' && lastMessage.parts) {
    const toolCalls = lastMessage.parts.filter(part => part.functionCall);
    if (toolCalls.length > 0) {
      // Find which tool call created this session (by checking suffix in args)
      let creatingToolIndex = -1;
      if (isChildSession && suffix) {
        creatingToolIndex = toolCalls.findIndex(part => 
          part.functionCall?.name === 'create_child_session' && 
          part.functionCall?.args?.suffix === suffix
        );
      }

      // Add tool responses for all tool calls
      forkedSession.history.push({
        role: 'user',
        parts: toolCalls.map((part, index) => ({
          functionResponse: {
            tool_use_id: part.functionCall!.id,
            name: part.functionCall!.name,
            response: {
              output: index === creatingToolIndex
                ? `Child session created: ${newSessionId}`
                : `Pending execution in parent session`
            }
          }
        })),
        __meta: { timestamp: Date.now() }
      });
    }
  }

  // Add separator message
  forkedSession.history.push({
    role: 'user',
    parts: [systemPart('--- HISTORY ABOVE IS INHERITED FROM PARENT SESSION FOR REFERENCE ONLY --- FOLLOW THE INSTRUCTIONS BELOW')],
    __meta: { timestamp: Date.now() }
  });

  const systemMessage = isChildSession
    ? `You are a child session forked from parent session \`${sourceSessionId}\`. Your current session ID is \`${newSessionId}\`. When you finish the task, explicitly call send_to_session({sessionId: \`${sourceSessionId}\`, message: "..."}).`
    : `Session forked from ${sourceSessionId} by user command. Your current session ID is \`${newSessionId}\`.`;

  forkedSession.history.push({
    role: 'user',
    parts: [systemPart(systemMessage)],
    __meta: { timestamp: Date.now() }
  });

  // Add a model acknowledgment to prevent LLM from re-processing inherited history
  if (isChildSession) {
    forkedSession.history.push({
      role: 'model',
      parts: [{ text: 'Understood. I am a child session. Waiting for task from parent session.' }],
      __meta: { timestamp: Date.now() }
    });
  }

  sessions.set(newSessionId, forkedSession);
  
  
  logger.info({ sourceSessionId, newSessionId, isChildSession }, 'Session forked');

  await saveSession(newSessionId);
  return newSessionId;
}

/**
 * Create a child session (for multi-agent)
 * @param parentSessionId Parent session ID
 * @param suffix Suffix for the new session ID
 * @param fork Whether to fork (inherit context) or create new
 * @returns New child session ID
 */
export async function createChildSession(parentSessionId: string, suffix: string, fork: boolean = true, options?: { node?: string; isolated?: boolean }): Promise<string> {
  if (fork) {
    // Fork from parent (inherit context)
    return await forkSession(parentSessionId, suffix, true, options);
  } else {
    // Create new empty session
    const parentSession = await getSession(parentSessionId);
    const childSessionId = `${parentSessionId}_${suffix}`;

    const agentName = parentSession.agent || 'main';
    const snapshot = await llm.getPersistentMemory(agentName);
    const newSession: Session = {
      id: childSessionId,
      agent: agentName,
      history: [],
      persistentMemorySnapshot: snapshot,
      stats: {
        totalCachedTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastUsage: null
      },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      vectorIndexPosition: 0,
      parentSessionId: parentSessionId,
      currentNode: options?.node || parentSession.currentNode || 'master',
      isolated: options?.isolated ?? parentSession.isolated,
      model: parentSession.model
    };

    newSession.history.push({
      role: 'user',
      parts: [systemPart(`You are a child session (new, empty context) with parent session \`${parentSessionId}\`. Your current session ID is \`${childSessionId}\`. When you finish, explicitly call send_to_session({sessionId: \`${parentSessionId}\`, message: "..."}).`)],
      __meta: { timestamp: Date.now() }
    });

    sessions.set(childSessionId, newSession);

    logger.info({ parentSessionId, childSessionId, fork: false }, 'Child session created');

    await saveSession(childSessionId);
    return childSessionId;
  }
}

async function persistSessionMetadataUpdate(sessionId: string, updates: Partial<Session>): Promise<void> {
  const historyFile = path.join(SESSIONS_DIR, `${sessionId}.json`);

  if (await fs.pathExists(historyFile)) {
    const historyData = await fs.readJson(historyFile);
    await fs.writeJson(historyFile, { ...historyData, ...updates }, { spaces: 2 });
    return;
  }

  await saveSession(sessionId);
}

export async function setSessionParent(childSessionId: string, parentSessionId?: string): Promise<{
  childSessionId: string;
  parentSessionId?: string;
  previousParentSessionId?: string;
}> {
  const childSession = await getExistingSession(childSessionId);
  if (!childSession) {
    throw new Error(`Session "${childSessionId}" not found.`);
  }

  const realChildId = childSession.id;
  const previousParentSessionId = childSession.parentSessionId || undefined;

  let realParentId: string | undefined;
  if (parentSessionId) {
    const parentSession = await getExistingSession(parentSessionId);
    if (!parentSession) {
      throw new Error(`Session "${parentSessionId}" not found.`);
    }

    realParentId = parentSession.id;
    if (realParentId === realChildId) {
      throw new Error('A session cannot be its own parent.');
    }
  }

  if (previousParentSessionId === realParentId) {
    return {
      childSessionId: realChildId,
      parentSessionId: realParentId,
      previousParentSessionId,
    };
  }

  childSession.parentSessionId = realParentId;
  await persistSessionMetadataUpdate(realChildId, { parentSessionId: realParentId });
  await saveSessionsMetadata();

  if (onSessionListUpdated) {
    onSessionListUpdated();
  }

  return {
    childSessionId: realChildId,
    parentSessionId: realParentId,
    previousParentSessionId,
  };
}

export async function updateChildSessionParentIds(oldParentSessionId: string, newParentSessionId: string): Promise<string[]> {
  const updatedChildIds: string[] = [];

  for (const [sessionId, session] of sessions.entries()) {
    if (session.parentSessionId !== oldParentSessionId) {
      continue;
    }

    session.parentSessionId = newParentSessionId;
    await persistSessionMetadataUpdate(sessionId, { parentSessionId: newParentSessionId });
    updatedChildIds.push(sessionId);
  }

  if (updatedChildIds.length > 0) {
    await saveSessionsMetadata();

    if (onSessionListUpdated) {
      onSessionListUpdated();
    }
  }

  return updatedChildIds;
}

/**
 * Check if a session operation is allowed based on isolated rules
 * @param sourceSession Source session (or undefined for system operations)
 * @param targetSessionId Target session ID
 * @param operation Operation name for error messages
 */
async function checkIsolatedPermission(
  sourceSession: Session | undefined,
  targetSessionId: string,
  operation: string
): Promise<void> {
  // If source session is isolated, deny all cross-session operations
  if (sourceSession?.isolated) {
    throw new Error(`Isolated session cannot use ${operation} tool.`);
  }

  // Get target session
  const targetSession = await getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session "${targetSessionId}" not found.`);
  }

  // If no source session (system operation), allow
  if (!sourceSession) {
    return;
  }

  const sourceAgent = sourceSession.agent || 'main';
  const targetAgent = targetSession.agent || 'main';

  // Check source agent isolation
  const sourceAgentMeta = getAgentMetadata(sourceAgent);
  if (sourceAgentMeta.isolated && sourceAgent !== targetAgent) {
    throw new Error(`Agent "${sourceAgent}" is isolated and cannot operate on sessions in other agents.`);
  }

  // Check target agent isolation
  const targetAgentMeta = getAgentMetadata(targetAgent);
  if (targetAgentMeta.isolated && sourceAgent !== targetAgent) {
    throw new Error(`Agent "${targetAgent}" is isolated and cannot be accessed from other agents.`);
  }
}

/**
 * Send a message to a session (add to queue)
 * @param targetSessionId Target session ID
 * @param message Message text
 * @param fromSessionId Optional source session ID for tracking
 */
function isRelatedSession(a: Session | undefined, b: Session | undefined): boolean {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.parentSessionId === b.id || b.parentSessionId === a.id) return true;
  if (a.parentSessionId && a.parentSessionId === b.parentSessionId) return true;
  return false;
}

export async function sendToSession(targetSessionId: string, message: string, fromSessionId?: string): Promise<void> {
  const targetSession = await getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \"${targetSessionId}\" not found.`);
  }
  const fromSession = fromSessionId ? await getExistingSession(fromSessionId) : undefined;
  if (fromSessionId && !fromSession) {
    throw new Error(`Session \"${fromSessionId}\" not found.`);
  }

  // Check isolated permissions
  await checkIsolatedPermission(fromSession, targetSessionId, 'send_to_session');

  if ((fromSession?.isolated || targetSession?.isolated) && !isRelatedSession(fromSession, targetSession)) {
    throw new Error('Isolated session can only communicate with parent/child sessions.');
  }

  // Use [SYSTEM: ...] prefix to avoid duplicate [FROM: ...] prefix in messageRouter
  let prefix = fromSessionId ? `[SYSTEM: Message from other session \`${fromSessionId}\`]\n` : '[SYSTEM MESSAGE]\n';

  if (fromSessionId && (fromSession?.parentSessionId === targetSessionId || targetSession?.parentSessionId === fromSessionId)) {
    const replyTarget = fromSessionId;
    prefix += `[SYSTEM: You can reply using send_to_session({sessionId: \`${replyTarget}\`, message: "..."}).]\n`;
  }

  const fullMessage = prefix + message;

  logger.info({ targetSessionId, fromSessionId }, 'Message sent to session');
  await enqueueSessionItem(targetSessionId, {
    type: 'intersession',
    parts: [{ text: fullMessage }]
  });
}


/**
 * Save a single session's history to its file
 */
export async function saveSession(sessionId: string): Promise<void> {
  try {
    const session = sessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Session not found for saving');
      return;
    }

    // Initialize historyVersion if not exists
    if (session.historyVersion === undefined) {
      session.historyVersion = 0;
    }

    // Index new messages if needed (async, non-blocking)
    try {
      const lastPos = session.vectorIndexPosition || 0;
      const newMessageCount = session.history.length - lastPos;

      if (newMessageCount > 0) {
        let totalTokens = 0;
        totalTokens = estimateSessionRangeTokens(session, lastPos);

        if (totalTokens >= 10000) {
          // Check if already indexing
          if (!session.indexingState?.inProgress) {
            // Mark as indexing
            const currentVersion = session.historyVersion;
            session.indexingState = {
              inProgress: true,
              startPosition: lastPos,
              endPosition: session.history.length,
              startTime: Date.now(),
              historyVersion: currentVersion
            };
            
            logger.info({ sessionId, newMessageCount, totalTokens, lastPos }, 'Starting async indexing');
            
            // Start async indexing (don't await)
            vector.indexNewMessages(sessionId, session.history, lastPos)
              .then(newPos => {
                // Check if history was modified during indexing
                if (session.historyVersion !== currentVersion) {
                  logger.warn({ sessionId, oldVersion: currentVersion, newVersion: session.historyVersion }, 
                    'History was modified during indexing (compact/clear), not updating vectorIndexPosition');
                  session.indexingState = undefined;
                  return;
                }
                
                session.vectorIndexPosition = newPos;
                session.indexingState = undefined;
                logger.info({ sessionId, newPos }, 'Async indexing completed');
                // Save session to persist updated position
                saveSession(sessionId).catch(e => 
                  logger.error({ err: e, sessionId }, 'Failed to save after indexing')
                );
              })
              .catch(e => {
                logger.error({ err: e, sessionId }, 'Failed to index messages');
                session.indexingState = undefined;
              });
          } else {
            logger.debug({ sessionId }, 'Indexing already in progress, skipping');
          }
        }
      }
    } catch (e) {
      logger.error({ err: e, sessionId }, 'Failed to start indexing for session');
    }

    // Update message count in metadata
    session.meta.messageCount = session.history.length;

    // Ensure sessions directory exists
    await fs.ensureDir(SESSIONS_DIR);

    // Save history, persistentMemorySnapshot, parentSessionId, indexingState, historyVersion, displayName, currentNode, agent to separate file
    const historyFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
    await fs.ensureDir(path.dirname(historyFile));
    await fs.writeJson(historyFile, { 
      history: session.history,
      queue: session.queue,
      persistentMemorySnapshot: session.persistentMemorySnapshot,
      parentSessionId: session.parentSessionId,
      indexingState: session.indexingState,
      historyVersion: session.historyVersion,
      displayName: session.displayName,
      currentNode: session.currentNode,
      isolated: session.isolated,
      model: session.model,
      agent: session.agent,
      verbose: session.verbose,
      aliases: session.aliases,
      busy: session.busy
    }, { spaces: 2 });
    
    // Save metadata (lightweight operation)
    await saveSessionsMetadata();
    
    // Notify session list update
    if (onSessionListUpdated) {
      onSessionListUpdated();
    }
  } catch (e) {
    logger.error({ err: e, sessionId }, 'Failed to save session');
  }
}

/**
 * Save sessions metadata (sessions.json)
 */
export async function saveSessionsMetadata(): Promise<void> {
  try {
    // Backup existing sessions.json
    if (await fs.pathExists(SESSIONS_FILE)) {
      try {
        for (let i = 5; i >= 1; i--) {
          const oldBak = i === 1 ? SESSIONS_FILE + '.bak' : SESSIONS_FILE + '.' + (i - 1) + '.bak';
          const newBak = SESSIONS_FILE + '.' + i + '.bak';
          if (await fs.pathExists(oldBak)) {
            await fs.rename(oldBak, newBak);
          }
        }
        await fs.rename(SESSIONS_FILE, SESSIONS_FILE + '.1.bak');
      } catch (e) {
        logger.warn(e, 'Failed to backup metadata');
      }
    }

    const data: any = {
      sessions: {}
    };

    // Save session metadata (without history and persistentMemorySnapshot)
    for (const [sessionId, session] of sessions.entries()) {
      const { history, persistentMemorySnapshot, broadcast, ...metadata } = session;
      data.sessions[sessionId] = metadata;
    }

    await fs.writeJson(SESSIONS_FILE, data, { spaces: 2 });
  } catch (e) {
    logger.error(e, 'Failed to save metadata');
  }
}

export async function loadSessions(): Promise<void> {
  try {
    // Load agent metadata first
    await loadAgentMetadata();
    await loadChannels();
    
    if (await fs.pathExists(SESSIONS_FILE)) {
      const data = await fs.readJson(SESSIONS_FILE);

      // Load sessions metadata only (history will be loaded on-demand)
      const sessionsData = data.sessions || data;
      for (const sessionId in sessionsData) {
        // Skip channelAttachments key if it exists in old format
        if (sessionId === 'channelAttachments') continue;

        const metadata = sessionsData[sessionId];
        
        // Create session with metadata but empty history (will be loaded on-demand)
        const session: Session = {
          id: sessionId,
          busy: false,
          meta: { lastMessageTime: Date.now() },
          ...metadata,
          history: [], // Empty, will be loaded when getSession is called
          queue: metadata.queue || [],
        };

        sessions.set(sessionId, session);
      }

      // Load channel attachments (migrated to channels.json)
      if (data.channelAttachments) {
        for (const channelKey in data.channelAttachments) {
          const sessionId = data.channelAttachments[channelKey];
          channelAttachments.set(channelKey, { sessionId });
        }
        await saveChannels();
      }

      logger.info({ sessionCount: sessions.size, attachmentCount: channelAttachments.size }, 'Session metadata loaded');
    }
  } catch (e) {
    logger.error(e, 'Failed to load sessions');
  }
}

export async function forceIndexSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  try {
    const lastPos = session.vectorIndexPosition || 0;
    if (lastPos < session.history.length) {
      logger.info({ lastPos, historyLength: session.history.length }, 'Force indexing all remaining messages');
      const newPos = await vector.indexNewMessages(sessionId, session.history, lastPos);
      session.vectorIndexPosition = newPos;
      await saveSession(sessionId);
    }
  } catch (e) {
    logger.error({ err: e }, 'Failed to force index messages');
    throw e;
  }
}

async function forceIndexSessionInternal(sessionId: string, session: Session) {
  try {
    const lastPos = session.vectorIndexPosition || 0;
    if (lastPos < session.history.length) {
      logger.info({ lastPos, historyLength: session.history.length }, 'Force indexing all remaining messages');
      const newPos = await vector.indexNewMessages(sessionId, session.history, lastPos);
      session.vectorIndexPosition = newPos;
    }
  } catch (e) {
    logger.error({ err: e }, 'Failed to force index messages');
  }
}

export async function compactHistory(sessionId: string, keepPercent: number = COMPACT_PERCENT): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const history = session.history;
  if (history.length < 1) return;

  // Notify user that compaction is starting
  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, 'Compaction starting');
  if (session.broadcast) {
    session.broadcast('⚠️ Context size limit reached, compacting history...');
  }

  await forceIndexSessionInternal(sessionId, session);

  let splitIndex = Math.floor(history.length * (1 - keepPercent));

  if (keepPercent > 0) {
    while (splitIndex < history.length && history[splitIndex].role === 'tool') {
      splitIndex++;
    }
  } else {
    splitIndex = history.length;
  }

  const remaining = splitIndex < history.length ? history.slice(splitIndex) : [];

  const summaryPrompt = "[SYSTEM: COMPACTION STARTED: PAUSE YOUR WORK before compation done. Please summarize the entire session history above concisely NOW. Preserve key information and important context. The earlier part of the session will be removed to save space. Update memory if needed.]";

  try {
    const beforeCompactIndex = session.history.length;

    // Don't change snapshot and history before compacting LLM request,
    // to prevent recomputing whole history.
    await llm.chat([{ text: summaryPrompt }], session, 0);

    const summaryConversation = session.history.slice(beforeCompactIndex);
    if (summaryConversation.length < 2 /* summary system message + summary */) {
      throw new Error('No summary message');
    }

    await finalizeCompaction(sessionId, session, splitIndex, remaining, summaryConversation, '[SYSTEM: Compaction completed.]');
  } catch (e) {
    logger.error(e, 'Compaction failed');
  }
}

export async function compactHistoryWithSummary(sessionId: string, summary: string, keepPercent: number = COMPACT_PERCENT): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  if (!summary || !summary.trim()) {
    throw new Error('Summary is required for manual compaction.');
  }

  const history = session.history;
  if (history.length < 1) {
    throw new Error('History is empty.');
  }

  logger.info({ sessionId, hasBroadcast: !!session.broadcast }, 'Manual compaction starting');
  if (session.broadcast) {
    session.broadcast('⚠️ Manual compaction starting...');
  }

  await forceIndexSessionInternal(sessionId, session);

  let splitIndex = Math.floor(history.length * (1 - keepPercent));

  if (keepPercent > 0) {
    while (splitIndex < history.length && history[splitIndex].role === 'tool') {
      splitIndex++;
    }
  } else {
    splitIndex = history.length;
  }

  const remaining = splitIndex < history.length ? history.slice(splitIndex) : [];
  const now = Date.now();
  const summaryConversation: Message[] = [
    { role: 'user', parts: [{ text: '[SYSTEM: Manual compaction summary provided.]' }], __meta: { timestamp: now } },
    { role: 'model', parts: [{ text: summary.trim() }], __meta: { timestamp: now } },
  ];

  await finalizeCompaction(sessionId, session, splitIndex, remaining, summaryConversation, '[SYSTEM: Manual compaction completed.]');
}

async function finalizeCompaction(
  sessionId: string,
  session: Session,
  splitIndex: number,
  remaining: Message[],
  summaryConversation: Message[],
  completionMarker: string,
): Promise<void> {
  const now = Date.now();
  const summaryMessages: Message[] = [
    { role: 'user', parts: [{ text: '[SYSTEM: This session has been compacted. Messages before this are removed.]' }], __meta: { timestamp: now } },
    ...remaining,
    ...summaryConversation,
    { role: 'user', parts: [{ text: completionMarker }], __meta: { timestamp: now } },
  ];

  session.persistentMemorySnapshot = await llm.getPersistentMemory(session.agent || 'main');
  session.history = summaryMessages;
  // Reset vector index position to 0 since history was compacted
  session.vectorIndexPosition = 0;
  // Increment history version to invalidate ongoing indexing
  session.historyVersion = (session.historyVersion || 0) + 1;
  // Clear indexing state
  session.indexingState = undefined;

  await saveSession(sessionId);
  logger.info({ splitIndex, remainingCount: remaining.length }, 'History compacted successfully');

  if (session.broadcast) {
    session.broadcast(`Compaction completed. Removed ${splitIndex} messages.`);
  }
}

export async function deleteMessages(sessionId: string, num: number): Promise<{ deleted: number; remaining: number }> {
  const session = sessions.get(sessionId);
  if (!session) return { deleted: 0, remaining: 0 };
  if (!num || isNaN(num)) return { deleted: 0, remaining: session.history.length };

  await forceIndexSessionInternal(sessionId, session);

  const originalLen = session.history.length;
  let deleted = 0;

  if (num > 0) {
    deleted = Math.min(num, session.history.length);
    session.history = session.history.slice(deleted);
    if (session.vectorIndexPosition !== undefined) {
      session.vectorIndexPosition = Math.max(0, session.vectorIndexPosition - deleted);
    }
  } else if (num < 0) {
    const absNum = Math.min(Math.abs(num), session.history.length);
    deleted = absNum;
    session.history = session.history.slice(0, session.history.length - absNum);
    if (session.vectorIndexPosition !== undefined) {
      session.vectorIndexPosition = Math.min(session.vectorIndexPosition, session.history.length);
    }
  }

  session.historyVersion = (session.historyVersion || 0) + 1;
  session.indexingState = undefined;

  await saveSession(sessionId);
  return { deleted, remaining: session.history.length };
}

export async function clearSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    await forceIndexSessionInternal(sessionId, session);
    // Increment history version to invalidate ongoing indexing
    session.historyVersion = (session.historyVersion || 0) + 1;
    session.indexingState = undefined;
  }
  sessions.delete(sessionId);
  
  // Delete history file
  const historyFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (await fs.pathExists(historyFile)) {
    await fs.remove(historyFile);
  }
  
  await saveSessionsMetadata();
}

export function getUsageTotalTokens(finalUsage?: Partial<TokenUsage> & {
  cachedContentTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}): number {
  if (!finalUsage) return 0;

  const cachedTokens = finalUsage.cachedTokens ?? finalUsage.cachedContentTokenCount ?? 0;
  const inputTokens = finalUsage.inputTokens ?? finalUsage.promptTokenCount ?? 0;
  const outputTokens = finalUsage.outputTokens ?? finalUsage.candidatesTokenCount ?? 0;

  return cachedTokens + inputTokens + outputTokens;
}

export async function checkAndCompactIfNeeded(sessionId: string, finalUsage?: Partial<TokenUsage>) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const currentSize = finalUsage
    ? getUsageTotalTokens(finalUsage)
    : estimateSessionTokens(session);

  const { contextLimit } = resolveModelConfig(session.model);

  if (currentSize > contextLimit * 0.8) {
    logger.info({ currentSize, contextLimit }, 'Auto compact')
    await compactHistory(sessionId).catch(e => logger.error(e, 'Auto-compact failed'));
  }
}

export function getAllSessions(): Map<string, Session> {
  return sessions;
}

export function getAllAttachments(): Map<string, ChannelConfig> {
  return channelAttachments;
}

/**
 * Set callback to be called when a session event is queued to an idle session
 */
export function setSessionTriggerCallback(onTrigger: (sessionId: string) => void): void {
  onSessionTriggered = onTrigger;
}

export async function enqueueSessionItem(sessionId: string, item: QueueItem): Promise<void> {
  const session = await getSession(sessionId);

  session.queue.push(item);
  await saveSession(sessionId);

  if (!session.busy) {
    onSessionTriggered?.(sessionId);
  }
}

/**
 * Queue an event notification to a session (unified handler for all event types)
 * @param sessionId Target session ID
 * @param message Event message
 * @param type Event type (background, trigger, onboot, etc.)
 */
export async function queueSessionEvent(sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type,
    parts: [{ text: message }]
  });
}

/**
 * Notify history update (for SSE broadcasting)
 */
export function notifyHistoryUpdate(sessionId: string, message: Message) {
  if (onHistoryUpdated) {
    onHistoryUpdated(sessionId, message);
  }
}

export async function appendSessionMessage(sessionOrId: Session | string, message: Message): Promise<void> {
  const session = typeof sessionOrId === 'string'
    ? await getSession(sessionOrId)
    : sessionOrId;

  session.history.push(message);
  await saveSession(session.id);
  notifyHistoryUpdate(session.id, message);
}


/**
 * Get list of all session IDs with basic info
 */
export function listSessions(): Array<{ id: string; messageCount: number; lastMessageTime: number | null; hasChannel: boolean; displayName?: string; currentNode?: string; isolated?: boolean; busy?: boolean; queueLength?: number }> {
  const result = [];
  
  // Iterate through all sessions in memory (metadata is always loaded)
  for (const [id, session] of sessions.entries()) {
    const channel = getChannelBySession(id);
    
    // Get messageCount from metadata (preferred) or fallback to history.length
    const messageCount = session.meta?.messageCount || session.history.length;
    const lastMessageTime = session.meta?.lastMessageTime || null;
    
    result.push({
      id,
      messageCount,
      lastMessageTime,
      hasChannel: !!channel,
      displayName: session.displayName,
      currentNode: session.currentNode,
      isolated: session.isolated,
      busy: session.busy,
      queueLength: session.queue?.length || 0
    });
  }
  
  return result.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
}

/**
 * Get messages from a session with pagination
 */
export async function getSessionMessages(sessionId: string, start?: number, count?: number): Promise<Message[]> {
  const session = await getExistingSession(sessionId);
  if (!session) {
    return [];
  }
  const history = session.history;
  
  if (start === undefined && count === undefined) {
    return history;
  }
  
  const startIdx = start || 0;
  const endIdx = count !== undefined ? startIdx + count : history.length;
  
  return history.slice(startIdx, endIdx);
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  if (!sessions.has(sessionId)) {
    return false;
  }
  
  // Remove from memory
  sessions.delete(sessionId);
  
  // Remove channel attachments
  for (const [key, info] of channelAttachments.entries()) {
    if (info.sessionId === sessionId) {
      channelAttachments.delete(key);
    }
  }
  saveChannels().catch(err => logger.error({ err }, 'Failed to save channels'));
  
  // Delete session file
  const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (await fs.pathExists(sessionFile)) {
    await fs.remove(sessionFile);
  }
  
  // Save metadata
  await saveSessionsMetadata();
  await saveChannels();
  
  // Notify session list update
  if (onSessionListUpdated) {
    onSessionListUpdated();
  }
  
  return true;
}

/**
 * Archive or unarchive a session
 */
export async function archiveSession(sessionId: string, archived: boolean = true): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.archived = archived;
  // Archive is metadata-only; avoid touching session history file
  await saveSessionsMetadata();
  
  // Notify session list update
  if (onSessionListUpdated) {
    onSessionListUpdated();
  }
  
  return true;
}

/**
 * Retry session - reactivate without adding new message
 * Useful for retrying after LLM errors
 */
export async function retrySession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.busy) {
    throw new Error('Session is already busy');
  }

  // Trigger session processing by adding a retry marker to queue
  logger.info({ sessionId }, 'Retrying session');
  await queueSessionEvent(sessionId, '[SYSTEM: retrying last request]', 'trigger');
}

/**
 * Resume busy sessions after restart
 * Called during startup to reactivate sessions that were interrupted
 */
export async function resumeBusySessions(): Promise<void> {
  const busySessionIds: string[] = [];
  const queuedSessionIds: string[] = [];

  // Check metadata for busy or queued sessions (no need to load history files)
  for (const [sessionId, session] of sessions.entries()) {
    if (session.busy === true) {
      busySessionIds.push(sessionId);
      continue;
    }

    if ((session.queue?.length || 0) > 0) {
      queuedSessionIds.push(sessionId);
    }
  }

  if (busySessionIds.length === 0 && queuedSessionIds.length === 0) {
    logger.info({ busyCount: 0, queuedCount: 0, busySessions: busySessionIds, queuedSessions: queuedSessionIds }, 'Resuming sessions after restart');
    return;
  }

  logger.info({ busyCount: busySessionIds.length, queuedCount: queuedSessionIds.length, busySessions: busySessionIds, queuedSessions: queuedSessionIds }, 'Resuming sessions after restart');

  for (const sessionId of busySessionIds) {
    try {
      // Get session (will load history if needed)
      const session = await getSession(sessionId);
      // Reset busy flag and trigger
      session.busy = false;
      // Will save session inside, no need to call saveSession() here.
      await queueSessionEvent(sessionId, '[SYSTEM: session resumed after process restart]');
      logger.info({ sessionId }, 'Busy session resumed');
    } catch (e) {
      logger.error({ err: e, sessionId }, 'Failed to resume busy session');
    }
  }

  for (const sessionId of queuedSessionIds) {
    try {
      onSessionTriggered?.(sessionId);
      logger.info({ sessionId }, 'Queued session resumed');
    } catch (e) {
      logger.error({ err: e, sessionId }, 'Failed to resume queued session');
    }
  }
}
