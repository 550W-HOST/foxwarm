/**
 * Session Manager - manages sessions independently of channels
 * A session can be attached to multiple channels
 */

import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { Session, Message, MessagePart, QueueItem, TokenUsage, SessionStreamEvent } from './types';
import { logger } from './common';
import { ChannelFile, ChannelSendFileOptions } from './channel';
import * as llm from './llm';
import { buildChildCompletionInstruction } from './session/childSessionReminder';
import { cloneQueueItem, getManagedSessionState, isManagedSessionLeaseExpired, ManagedSessionState, setManagedSessionState, shouldRouteQueueItemToManagedInbox } from './session/managedState';
import * as vector from './vector';
import { SESSIONS_FILE, SESSIONS_DIR, COMPACT_PERCENT, getAgentDir, getLegacySessionFrontierPath } from './config';
import * as sessionAgentOps from './session/agentOps';
import * as sessionAgentMetadata from './session/agentMetadata';
import { appendMessagesToArchive, getNextSessionMessageSeq } from './session/archive';
import { annotateHistoryWithContextFrontierMetadata, appendMessagesToContextFrontier, readArchiveBlocksByIdRange, renderHistoryFromFrontier } from './session/layeredContext';
import { ensureSessionBranch, hasArchivedSessionId } from './session/archiveStore';
import { applySessionHistoryState, getSessionHistoryFilePath, loadSessionsMetadataSnapshot, readSessionHistorySnapshot, serializeSessionHistoryPayload, stripSessionMetadataForSave, writeSessionHistoryAtomically, writeSessionsMetadataAtomically } from './session/metadataStore';
import * as sessionChannels from './session/channels';
import * as sessionHistory from './session/history';
import * as sessionRelations from './session/relations';
import { formatSessionIdentityHint } from './session/identityHint';
import { maybeBuildGoalReminderMessage } from './session/goal';
import { buildSystemMessageParts } from './utils/systemMessageParts';
import { formatFoxwarmMessage, formatFoxwarmSystem, formatFoxwarmSystemClose, formatFoxwarmSystemOpen, formatSystemPartForModel } from './utils/promptWrappers';
import { runStartupMigrations } from './migrations';
import {
  buildSessionRuntimeState,
  clearActiveSessionRuntimeState,
  formatSessionRuntimeStateSummary,
  setActiveSessionRuntimeState,
  setSessionRuntimeStateUpdateCallback,
  type ActiveSessionRuntimeStateInput,
  type SessionRuntimeState,
} from './sessionRuntimeState';

function systemPart(system: string): MessagePart {
  return { system: formatSystemPartForModel(system) };
}

const MANAGED_OWNER_WAKEUP_COOLDOWN_MS = 30 * 1000;

export interface SessionWaitState {
  id: string;
  startedAt: number;
  reason?: string;
  timeoutSeconds?: number;
  waitExecIds?: string[];
  waitAll?: SessionWaitAllState;
}

export interface SessionWaitAllState {
  sessions: string[];
  satisfiedSessions: string[];
  deferredQueue: QueueItem[];
}

type WaitQueueTransition =
  | { action: 'drop' }
  | { action: 'defer' }
  | { action: 'enqueue'; items: QueueItem[] };

function getSessionWaitState(session?: Session): SessionWaitState | undefined {
  const wait = session?.meta?.wait;
  if (!wait || typeof wait !== 'object' || typeof wait.id !== 'string') {
    return undefined;
  }

  return wait as SessionWaitState;
}

function clearSessionWaitState(session: Session): boolean {
  if (!getSessionWaitState(session)) {
    return false;
  }

  delete session.meta.wait;
  return true;
}

function isWaitNeutralMaintenanceQueueItem(item: QueueItem): boolean {
  // These items represent internal compaction maintenance, not external input.
  // They may be processed while a session is waiting, but should not consume the
  // wait token or make a later wait-timeout event stale.
  return item.type === 'compact' || item.type === 'compact-commit';
}

function getWaitAllState(wait: SessionWaitState): SessionWaitAllState | undefined {
  const waitAll = wait.waitAll;
  if (!waitAll || typeof waitAll !== 'object' || !Array.isArray(waitAll.sessions)) {
    return undefined;
  }

  if (!Array.isArray(waitAll.satisfiedSessions)) {
    waitAll.satisfiedSessions = [];
  }
  if (!Array.isArray(waitAll.deferredQueue)) {
    waitAll.deferredQueue = [];
  }

  return waitAll;
}

function getWaitAllPendingSessions(waitAll: SessionWaitAllState): string[] {
  const satisfied = new Set(waitAll.satisfiedSessions);
  return waitAll.sessions.filter(sessionId => !satisfied.has(sessionId));
}

function buildWaitAllPendingReminder(pendingSessions: string[]): string {
  return formatFoxwarmSystem({
    kind: 'event',
    type: 'wait-all-pending',
    pendingSessions: pendingSessions.join(','),
  }, `waitAllSessions is still pending for: ${pendingSessions.map(sessionId => `\`${sessionId}\``).join(', ')}. This session was woken before every listed session sent a new message after the wait started.`);
}

function buildWaitAllPendingReminderItem(pendingSessions: string[]): QueueItem | undefined {
  if (pendingSessions.length === 0) {
    return undefined;
  }

  return {
    type: 'background',
    parts: buildSystemMessageParts(buildWaitAllPendingReminder(pendingSessions)),
  };
}

function cloneQueueItems(items: QueueItem[]): QueueItem[] {
  return items.map(item => cloneQueueItem(item));
}

function buildWaitAllUnrelatedWakeItems(waitAll: SessionWaitAllState, item: QueueItem): QueueItem[] {
  const pendingSessions = getWaitAllPendingSessions(waitAll);
  const items = [
    ...cloneQueueItems(waitAll.deferredQueue),
    cloneQueueItem(item),
  ];
  const reminderItem = buildWaitAllPendingReminderItem(pendingSessions);
  if (reminderItem) {
    items.push(reminderItem);
  }
  return items;
}

function getListedWaitAllSourceSession(waitAll: SessionWaitAllState, item: QueueItem): string | undefined {
  if (item.type !== 'intersession' || typeof item.sourceSessionId !== 'string') {
    return undefined;
  }

  return waitAll.sessions.includes(item.sourceSessionId) ? item.sourceSessionId : undefined;
}

function markWaitAllSessionSatisfied(waitAll: SessionWaitAllState, sourceSessionId: string): void {
  if (!waitAll.satisfiedSessions.includes(sourceSessionId)) {
    waitAll.satisfiedSessions.push(sourceSessionId);
  }
}

function applyQueuedItemToWaitState(session: Session, item: QueueItem): WaitQueueTransition {
  const wait = getSessionWaitState(session);
  if (!wait) {
    if (typeof item.waitTimeoutId === 'string') {
      logger.info({ sessionId: session.id, waitId: item.waitTimeoutId }, 'Ignoring wait timeout event with no active wait state');
      return { action: 'drop' };
    }

    return { action: 'enqueue', items: [item] };
  }

  const waitAll = getWaitAllState(wait);

  if (typeof item.waitTimeoutId === 'string') {
    if (item.waitTimeoutId !== wait.id) {
      logger.info({ sessionId: session.id, waitId: item.waitTimeoutId, activeWaitId: wait.id }, 'Ignoring stale wait timeout event');
      return { action: 'drop' };
    }

    if (waitAll) {
      const pendingSessions = getWaitAllPendingSessions(waitAll);
      const items = buildWaitAllUnrelatedWakeItems(waitAll, item);
      clearSessionWaitState(session);
      logger.debug({ sessionId: session.id, waitId: wait.id, pendingSessions }, 'Cleared waitAll state due to wait timeout event');
      return { action: 'enqueue', items };
    }

    clearSessionWaitState(session);
    return { action: 'enqueue', items: [item] };
  }

  if (isWaitNeutralMaintenanceQueueItem(item)) {
    logger.debug({ sessionId: session.id, waitId: wait.id, queuedType: item.type }, 'Leaving active wait state unchanged for maintenance queue item');
    return { action: 'enqueue', items: [item] };
  }

  if (waitAll) {
    const listedSourceSessionId = getListedWaitAllSourceSession(waitAll, item);
    if (listedSourceSessionId) {
      waitAll.deferredQueue.push(cloneQueueItem(item));
      markWaitAllSessionSatisfied(waitAll, listedSourceSessionId);
      const pendingSessions = getWaitAllPendingSessions(waitAll);
      if (pendingSessions.length > 0) {
        logger.debug({ sessionId: session.id, waitId: wait.id, sourceSessionId: listedSourceSessionId, pendingSessions }, 'Deferred waitAllSessions intersession message');
        return { action: 'defer' };
      }

      const items = cloneQueueItems(waitAll.deferredQueue);
      clearSessionWaitState(session);
      logger.debug({ sessionId: session.id, waitId: wait.id }, 'waitAllSessions satisfied; flushing deferred messages');
      return { action: 'enqueue', items };
    }

    const pendingSessions = getWaitAllPendingSessions(waitAll);
    const items = buildWaitAllUnrelatedWakeItems(waitAll, item);
    clearSessionWaitState(session);
    logger.debug({ sessionId: session.id, waitId: wait.id, queuedType: item.type, pendingSessions }, 'Cleared waitAll state due to unrelated wake item');
    return { action: 'enqueue', items };
  }

  clearSessionWaitState(session);
  logger.debug({ sessionId: session.id, waitId: wait.id, queuedType: item.type }, 'Cleared active wait state due to new session queue item');
  return { action: 'enqueue', items: [item] };
}

export function clearSessionWaitForDirectTurn(session: Session, wakeType: string = 'direct-turn'): boolean {
  const wait = getSessionWaitState(session);
  if (!wait) {
    return false;
  }

  clearSessionWaitState(session);
  logger.debug({ sessionId: session.id, waitId: wait.id, wakeType }, 'Cleared active wait state due to direct session turn');
  return true;
}

export async function startSessionWait(sessionId: string, options: {
  reason?: string;
  timeoutSeconds?: number;
  waitAllSessions?: string[];
  waitExecIds?: string[];
} = {}): Promise<SessionWaitState> {
  const session = await getSession(sessionId);
  const existingWait = getSessionWaitState(session);
  const existingWaitAll = existingWait ? getWaitAllState(existingWait) : undefined;
  if (existingWaitAll?.deferredQueue.length) {
    throw new Error('Cannot start a new wait while the previous waitAllSessions has deferred messages. Wake or clear the existing wait before starting another one.');
  }

  const state: SessionWaitState = {
    id: randomUUID(),
    startedAt: Date.now(),
  };

  if (typeof options.reason === 'string' && options.reason.trim()) {
    state.reason = options.reason.trim();
  }
  if (typeof options.timeoutSeconds === 'number' && Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0) {
    state.timeoutSeconds = options.timeoutSeconds;
  }
  if (Array.isArray(options.waitExecIds) && options.waitExecIds.length > 0) {
    state.waitExecIds = [...options.waitExecIds];
  }
  if (Array.isArray(options.waitAllSessions) && options.waitAllSessions.length > 0) {
    state.waitAll = {
      sessions: [...options.waitAllSessions],
      satisfiedSessions: [],
      deferredQueue: [],
    };
  }

  session.meta.wait = state;
  await saveSession(session.id);
  return state;
}

export async function queueSessionWaitTimeoutEvent(sessionId: string, waitId: string, message: string): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type: 'background',
    parts: buildSystemMessageParts(message),
    waitTimeoutId: waitId,
  });
}

export const ARCHIVED_SESSION_ID_ERROR_CODE = 'SESSION_ID_ARCHIVED';

export class ArchivedSessionIdError extends Error {
  readonly code = ARCHIVED_SESSION_ID_ERROR_CODE;

  constructor(sessionId: string) {
    super(`Session "${sessionId}" cannot be created because that internal session ID is reserved by retained archive history.`);
    this.name = 'ArchivedSessionIdError';
  }
}

type SessionIdReservation = 'live' | 'archived' | null;

async function hasPersistedLiveSessionId(sessionId: string): Promise<boolean> {
  if (sessions.has(sessionId) || await fs.pathExists(getSessionHistoryFilePath(sessionId))) {
    return true;
  }

  if (!await fs.pathExists(SESSIONS_FILE)) {
    return false;
  }

  try {
    const data = await fs.readJson(SESSIONS_FILE);
    const sessionsData = data?.sessions || data;
    return !!sessionsData && typeof sessionsData === 'object'
      && Object.prototype.hasOwnProperty.call(sessionsData, sessionId);
  } catch {
    return false;
  }
}

async function getSessionIdReservation(sessionId: string): Promise<SessionIdReservation> {
  const resolvedSessionId = await resolveSessionId(sessionId);
  if (resolvedSessionId !== sessionId) {
    return 'live';
  }

  if (await hasPersistedLiveSessionId(sessionId)) {
    return 'live';
  }

  return await hasArchivedSessionId(sessionId) ? 'archived' : null;
}

export async function assertSessionIdAvailableForNewLifetime(sessionId: string): Promise<void> {
  const reservation = await getSessionIdReservation(sessionId);
  if (reservation === 'live') {
    throw new Error(`Session "${sessionId}" already exists.`);
  }
  if (reservation === 'archived') {
    throw new ArchivedSessionIdError(sessionId);
  }
}

async function isSessionIdReserved(sessionId: string): Promise<boolean> {
  return await getSessionIdReservation(sessionId) !== null;
}

async function allocateGeneratedSessionId(): Promise<string> {
  while (true) {
    const candidate = generateSessionId();
    if (!await isSessionIdReserved(candidate)) {
      return candidate;
    }
  }
}

export async function generateAvailableSessionName(agentName: string = 'main'): Promise<string> {
  while (true) {
    const sessionName = generateSessionId();
    const sessionId = agentName === 'main' ? sessionName : `${agentName}/${sessionName}`;
    if (!await isSessionIdReserved(sessionId)) {
      return sessionName;
    }
  }
}

async function allocateForkSessionId(sourceSessionId: string, suffix?: string, replaceMainLeaf = false): Promise<string> {
  const requestedSuffix = (suffix || 'fork').trim() || 'fork';
  const baseId = replaceMainLeaf
    ? buildChildSessionId(sourceSessionId, requestedSuffix)
    : `${sourceSessionId}_${requestedSuffix}`;

  if (!await isSessionIdReserved(baseId)) {
    return baseId;
  }

  let counter = 2;
  while (true) {
    const candidate = `${baseId}_${counter}`;
    if (!await isSessionIdReserved(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}

function isMainSessionId(sessionId: string): boolean {
  const parts = sessionId.split('/');
  return parts[parts.length - 1] === 'main';
}

export function buildAgentMainSessionId(agentName: string): string {
  return agentName === 'main' ? 'main' : `${agentName}/main`;
}

export function buildChildSessionId(parentSessionId: string, suffix: string): string {
  return isMainSessionId(parentSessionId)
    ? [...parentSessionId.split('/').slice(0, -1), suffix].join('/') || suffix
    : `${parentSessionId}_${suffix}`;
}

async function allocateChildSessionId(parentSessionId: string, suffix: string): Promise<string> {
  const requestedSuffix = (suffix || 'child').trim() || 'child';
  const baseId = buildChildSessionId(parentSessionId, requestedSuffix);

  if (!await isSessionIdReserved(baseId)) {
    return baseId;
  }

  let counter = 2;
  while (true) {
    const candidate = `${baseId}_${counter}`;
    if (!await isSessionIdReserved(candidate)) {
      return candidate;
    }
    counter += 1;
  }
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
  if (session) {
    // Sessions loaded from sessions.json start as metadata-only placeholders
    // with an empty history array. Delegate to getSession() so callers that
    // later save or inspect the session do not accidentally operate on an
    // unloaded placeholder and overwrite the on-disk history.
    return await getSession(realId);
  }

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

export type ChannelMode = sessionChannels.ChannelMode;

// Callback to trigger agent turn
let onSessionTriggered: ((sessionId: string) => void | Promise<void>) | null = null;

// Callback when history is updated (for SSE broadcasting)
let onHistoryUpdated: ((sessionId: string, message: Message) => void) | null = null;

// Callback when transient session events are updated (for SSE broadcasting)
let onSessionEventUpdated: ((sessionId: string, event: SessionStreamEvent) => void) | null = null;

// Independent callbacks for global-list consumers and one-session consumers.
// The WebUI sidebar/architecture owns the former; each Chat stream owns the
// latter and never needs to refetch the full list for runtime state.
let onSessionListUpdated: (() => void) | null = null;
let onSessionStateUpdated: ((sessionId: string) => void) | null = null;

// Track active in-flight LLM requests so /stop can abort the underlying HTTP call.
const sessionAbortControllers = new Map<string, AbortController>();

export function setOnHistoryUpdated(callback: (sessionId: string, message: Message) => void) {
  onHistoryUpdated = callback;
}

export function setOnSessionEventUpdated(callback: (sessionId: string, event: SessionStreamEvent) => void) {
  onSessionEventUpdated = callback;
}

export function setOnSessionListUpdated(callback: () => void) {
  onSessionListUpdated = callback;
}

export function setOnSessionStateUpdated(callback: (sessionId: string) => void) {
  onSessionStateUpdated = callback;
}

export function registerSessionAbortController(sessionId: string, controller: AbortController): void {
  sessionAbortControllers.set(sessionId, controller);
}

export function clearSessionAbortController(sessionId: string, controller?: AbortController): void {
  const current = sessionAbortControllers.get(sessionId);
  if (!current) return;
  if (controller && current !== controller) return;
  sessionAbortControllers.delete(sessionId);
}

export function abortSessionInFlight(sessionId: string): boolean {
  const controller = sessionAbortControllers.get(sessionId);
  if (!controller) {
    return false;
  }

  sessionAbortControllers.delete(sessionId);
  controller.abort();
  return true;
}

export async function requestSessionStop(sessionId: string): Promise<{ abortedInFlight: boolean }> {
  const session = await getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  session.stopping = true;
  if (session.meta?.runQueuedAfterStop) {
    delete session.meta.runQueuedAfterStop;
  }
  const abortedInFlight = abortSessionInFlight(sessionId);
  await saveSession(sessionId);
  return { abortedInFlight };
}

export async function requestSessionDequeue(sessionId: string): Promise<{
  queuedItems: number;
  stoppedCurrent: boolean;
  abortedInFlight: boolean;
}> {
  const session = await getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  const queuedItems = session.queue?.length || 0;
  if (queuedItems === 0) {
    return { queuedItems, stoppedCurrent: false, abortedInFlight: false };
  }

  if (session.busy) {
    session.stopping = true;
    session.meta.runQueuedAfterStop = true;
    const abortedInFlight = abortSessionInFlight(sessionId);
    await saveSession(sessionId);
    return { queuedItems, stoppedCurrent: true, abortedInFlight };
  }

  await triggerSessionProcessing(sessionId);
  return { queuedItems, stoppedCurrent: false, abortedInFlight: false };
}

export async function prepareSessionForDestructiveAction(sessionId: string): Promise<{
  session: Session;
  requiresRetry: boolean;
  abortedInFlight: boolean;
  droppedQueueItems: number;
}> {
  const session = await getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  const droppedQueueItems = session.queue?.length || 0;
  const requiresRetry = !!session.busy;
  let abortedInFlight = false;
  let changed = false;

  if (droppedQueueItems > 0) {
    session.queue = [];
    changed = true;
  }

  if (session.busy) {
    session.stopping = true;
    abortedInFlight = abortSessionInFlight(sessionId);
    changed = true;
  }

  if (changed) {
    await saveSession(session.id);
  }

  return {
    session,
    requiresRetry,
    abortedInFlight,
    droppedQueueItems,
  };
}

export function generateSessionId(): string {
  const now = new Date();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substr(2, 5);
  return `${MM}${DD}_${random}`;
}

/**
 * Clear legacy history-based indexing state after upgrade to archive-based indexing.
 */
async function resumeIndexingIfNeeded(sessionId: string, session: Session): Promise<void> {
  if (!session.indexingState?.inProgress) return;

  logger.info({ sessionId }, 'Discarding legacy history-based indexing state after archive indexing upgrade');
  session.indexingState = undefined;
}

export async function getSession(sessionId: string): Promise<Session> {
  // Resolve alias first
  const realId = await resolveSessionId(sessionId);
  
  let session = sessions.get(realId);
  let isNew = false;
  if (!session) {
    const reservation = await getSessionIdReservation(realId);
    if (reservation === 'archived') {
      throw new ArchivedSessionIdError(realId);
    }

    // A persisted live record may be hydrated here even though it already has
    // archive rows. Only the absence of live persistence starts a new lifetime.
    isNew = reservation === null;
    session = {
      id: realId,
      history: [],
      persistentMemorySnapshot: '',
      promptCacheKey: llm.generatePromptCacheKey(),
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
        const historyData = await readSessionHistorySnapshot(realId);
        if (!historyData) {
          throw new Error('Session history file disappeared during read');
        }
        session.history = historyData.history || [];
        if (historyData.persistentMemorySnapshot) {
          session.persistentMemorySnapshot = historyData.persistentMemorySnapshot;
        }
        applySessionHistoryState(session, historyData);
        if (historyData.indexingState) {
          // Check if indexing was interrupted
          await resumeIndexingIfNeeded(sessionId, session);
        }
        logger.debug({ sessionId: realId, messageCount: session.history.length }, 'Session history loaded from file');
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
  session.systemPromptFiles = llm.normalizeSystemPromptFiles(session.systemPromptFiles);
  if (!session.persistentMemorySnapshot) session.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot({
    agentName: session.agent,
    sessionId: realId,
    systemPromptFiles: session.systemPromptFiles,
  });
  if (!session.stats) session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  if (session.stats.totalCachedTokens === null) session.stats.totalCachedTokens = 0;
  if (!session.queue) session.queue = [];
  if (session.busy === undefined) session.busy = false;
  if (session.busy && typeof session.busyStartedAt !== 'number') session.busyStartedAt = Date.now();
  if (!session.meta) session.meta = { lastMessageTime: Date.now() };
  if (!session.currentNode) session.currentNode = 'master'; // Default to master node
  delete (session as any).isolated;
  if (session.nextMessageSeq === undefined) {
    session.nextMessageSeq = getNextSessionMessageSeq(session);
  }
  if (session.contextFrontier && session.contextFrontier.length > 0) {
    if (session.history.length !== session.contextFrontier.length) {
      session.history = await renderHistoryFromFrontier(session);
    } else {
      const annotation = await annotateHistoryWithContextFrontierMetadata(session.id, session.history, session.contextFrontier);
      session.history = annotation.history;
      if (!annotation.matched) {
        logger.warn({ sessionId: session.id, warnings: annotation.warnings }, 'Loaded session context frontier did not exactly match rendered history; applied best-effort metadata annotations');
      }
    }
  }

  // Setup broadcast function
  if (!session.broadcast) {
    setupSessionBroadcast(sessionId);
  }

  return session;
}

export async function createEmptySession(sessionId?: string): Promise<{ session: Session; created: boolean }> {
  const targetSessionId = sessionId || await allocateGeneratedSessionId();
  const existingSession = await getExistingSession(targetSessionId);
  if (existingSession) {
    return { session: existingSession, created: false };
  }

  await assertSessionIdAvailableForNewLifetime(targetSessionId);

  const session = await getSession(targetSessionId);
  await saveSession(session.id);
  return { session, created: true };
}

export async function updateSessionBusyState(session: Session, busy: boolean): Promise<void> {
  const changed = session.busy !== busy;
  const busyStartedChanged = busy
    ? typeof session.busyStartedAt !== 'number'
    : session.busyStartedAt !== undefined;

  session.busy = busy;
  if (busy) {
    if (typeof session.busyStartedAt !== 'number') {
      session.busyStartedAt = Date.now();
    }
  } else {
    clearActiveSessionRuntimeState(session.id);
    session.busyStartedAt = undefined;
  }

  if (!changed && !busyStartedChanged) {
    return;
  }

  await saveSessionsMetadata();
  notifySessionUpdated(session.id);
}

/**
 * Create a new session with given data
 */
export async function createSession(sessionId: string, sessionData: any): Promise<void> {
  await assertSessionIdAvailableForNewLifetime(sessionId);
  if (sessionData && typeof sessionData === 'object') {
    delete sessionData.isolated;
    llm.ensurePromptCacheKey(sessionData as Session);
  }
  sessions.set(sessionId, sessionData);
  await saveSession(sessionId);
  logger.info({ sessionId }, 'Session created');
}

async function saveChannels(): Promise<void> {
  await sessionChannels.saveChannels();
}

async function loadChannels(): Promise<void> {
  await sessionChannels.loadChannels();
}

export const validateAgentName = sessionAgentOps.validateAgentName;
export const validateSessionName = sessionAgentOps.validateSessionName;

export function validateChildSessionSuffix(suffix: string): void {
  if (!suffix || typeof suffix !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(suffix)) {
    throw new Error('Invalid child session suffix. Use only alphanumeric characters, hyphens, and underscores.');
  }
}

function getSessionAgentOpsDeps() {
  return {
    getSession,
    getExistingSession,
    assertSessionIdAvailableForNewLifetime,
    createSession,
    saveSession,
    saveSessionsMetadata,
    saveChannels,
    updateAliasCache,
    updateChildSessionParentIds,
    moveSessionArchiveIndex: vector.renameSessionArchiveIndex,
    getAgentMetadata,
    getSessionsMap: getAllSessions,
    getAttachmentsMap: getAllAttachments,
  };
}

function getSessionHistoryDeps() {
  return {
    getSessionById: (sessionId: string) => sessions.get(sessionId),
    getExistingSession,
    saveSession,
    enqueueSessionItem,
    notifyHistoryUpdate,
  };
}

function notifySessionListUpdated() {
  onSessionListUpdated?.();
}

function notifySessionUpdated(sessionId: string) {
  notifySessionListUpdated();
  onSessionStateUpdated?.(sessionId);
}

setSessionRuntimeStateUpdateCallback((sessionId) => notifySessionUpdated(sessionId));

export { buildSessionRuntimeState, clearActiveSessionRuntimeState, formatSessionRuntimeStateSummary, setActiveSessionRuntimeState };
export type { ActiveSessionRuntimeStateInput, SessionRuntimeState };

function getAgentMetadataDeps() {
  return {
    getSession,
    getExistingSession,
    saveSession,
    getSessionsMap: getAllSessions,
    validateAgentName,
  };
}

export function getAgentMetadata(agentName: string): sessionAgentMetadata.AgentMetadata {
  return sessionAgentMetadata.getAgentMetadata(agentName);
}

export function getAgentIsolationNode(agentName: string): string | undefined {
  return sessionAgentMetadata.getAgentIsolationNode(agentName);
}

export function isAgentIsolated(agentName: string): boolean {
  return sessionAgentMetadata.isAgentIsolated(agentName);
}

export function isSessionEffectivelyIsolated(session?: Session | null): boolean {
  return sessionAgentMetadata.isSessionEffectivelyIsolated(session);
}

export async function setAgentMetadata(agentName: string, meta: sessionAgentMetadata.AgentMetadata): Promise<void> {
  await sessionAgentMetadata.setAgentMetadata(agentName, meta);
}

export async function refreshSessionSnapshot(sessionId: string): Promise<{ sessionId: string; agentName: string }> {
  return sessionAgentMetadata.refreshSessionSnapshot(getAgentMetadataDeps(), sessionId);
}

export function getAgentInheritanceChain(agentName: string): string[] {
  return sessionAgentMetadata.getAgentInheritanceChain(agentName);
}

export async function setAgentInherit(agentName: string, inheritAgentName?: string): Promise<{ affectedSessions: string[] }> {
  return sessionAgentMetadata.setAgentInherit(getAgentMetadataDeps(), agentName, inheritAgentName);
}

export async function setAgentIsolation(agentName: string, isolatedNode?: string): Promise<{ affectedSessions: string[]; isolated: boolean; node?: string }> {
  return sessionAgentMetadata.setAgentIsolation(getAgentMetadataDeps(), agentName, isolatedNode);
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
  isolatedNode?: string;
}): Promise<{
  agentDir: string;
  mainSessionId: string;
  convertedFromSessionId?: string;
  aliases: string[];
  updatedChildren: string[];
  createdMainSession: boolean;
}> {
  const { inherit, isolatedNode, ...createOptions } = options;
  const normalizedInherit = inherit && String(inherit).trim() ? String(inherit).trim() : undefined;
  const normalizedIsolatedNode = isolatedNode && String(isolatedNode).trim() ? String(isolatedNode).trim() : undefined;

  if (normalizedInherit !== undefined) {
    validateAgentName(normalizedInherit);
    if (!await fs.pathExists(getAgentDir(normalizedInherit))) {
      throw new Error(`Inherited agent "${normalizedInherit}" does not exist.`);
    }
  }

  const result = await sessionAgentOps.createAgentWithMainSession(createOptions, getSessionAgentOpsDeps());
  if (normalizedIsolatedNode !== undefined) {
    await setAgentIsolation(options.agentName, normalizedIsolatedNode);
  }
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
  systemPromptFiles?: string[];
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
 * @param channelId Configured channel instance id (for legacy configs this is usually the same as the channel type)
 * @param conversationId Channel-side conversation/chat/room target id
 * @param sessionId Existing session ID to attach
 * @returns The session ID
 */
export function attachChannel(channelId: string, conversationId: string, sessionId: string, configUpdates?: Partial<sessionChannels.ChannelConfig>): string {
  return sessionChannels.attachChannel(channelId, conversationId, sessionId, configUpdates);
}

export function getSessionByChannel(channelId: string, conversationId: string): string | undefined {
  return sessionChannels.getSessionByChannel(channelId, conversationId);
}

export function getChannelConfig(channelId: string, conversationId: string): sessionChannels.ChannelConfig | undefined {
  return sessionChannels.getChannelConfig(channelId, conversationId);
}

export function setChannelMode(channelId: string, conversationId: string, mode: ChannelMode | undefined) {
  sessionChannels.setChannelMode(channelId, conversationId, mode);
}

export function getChannelDangerouslyAllowAllUsers(channelId: string, conversationId: string): boolean {
  return sessionChannels.getChannelDangerouslyAllowAllUsers(channelId, conversationId);
}

export function setChannelDangerouslyAllowAllUsers(channelId: string, conversationId: string, value: boolean) {
  sessionChannels.setChannelDangerouslyAllowAllUsers(channelId, conversationId, value);
}

export function detachChannel(channelId: string, conversationId: string): void {
  sessionChannels.detachChannel(channelId, conversationId);
}

export async function sendToChannelTargetId(channelTargetId: string, message: string): Promise<void> {
  await sessionChannels.sendToChannelTargetId(channelTargetId, message);
}

export type FileDeliveryResult = sessionChannels.FileDeliveryResult;

export async function sendFileToChannelTargetId(channelTargetId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
  await sessionChannels.sendFileToChannelTargetId(channelTargetId, file, options);
}

export async function sendFileToSession(sessionId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<FileDeliveryResult> {
  return sessionChannels.sendFileToSession({ getExistingSession }, sessionId, file, options);
}

/**
 * Setup broadcast function for a session
 * Broadcasts messages to all attached channels
 */
export function setupSessionBroadcast(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.broadcast = sessionChannels.createSessionBroadcast(sessionId);
}

/**
 * Get all channels attached to a session
 */
export function getChannelsBySession(sessionId: string): Array<{ channelId: string; conversationId: string }> {
  return sessionChannels.getChannelsBySession(sessionId);
}

export function getChildSessionIds(parentSessionId: string): string[] {
  return sessionRelations.getChildSessionIds(sessions, parentSessionId);
}

export function getChannelBySession(sessionId: string): { channelId: string; conversationId: string } | undefined {
  return sessionChannels.getChannelBySession(sessionId, sessions.get(sessionId));
}

/**
 * Fork a session (create a copy with new ID)
 * @param sourceSessionId Source session ID to fork from
 * @param suffix Optional suffix for the new session ID
 * @param isChildSession Whether this is a child session (for multi-agent)
 * @returns New session ID
 */
export async function forkSession(sourceSessionId: string, suffix?: string, isChildSession: boolean = false, options?: { node?: string; model?: string }): Promise<string> {
  const sourceSession = await getSession(sourceSessionId);
  const realSourceSessionId = sourceSession.id || sourceSessionId;
  const newSessionId = await allocateForkSessionId(realSourceSessionId, suffix, isChildSession);
  const sourcePreviousPromptCacheKey = sourceSession.promptCacheKey;
  const promptCacheKey = llm.ensurePromptCacheKey(sourceSession);
  if (sourceSession.promptCacheKey !== sourcePreviousPromptCacheKey) {
    await saveSession(sourceSession.id);
  }

  const forkedSession: Session = {
    id: newSessionId,
    history: structuredClone(sourceSession.history),
    systemPromptFiles: sourceSession.systemPromptFiles ? [...sourceSession.systemPromptFiles] : undefined,
    persistentMemorySnapshot: sourceSession.persistentMemorySnapshot,
    promptCacheKey,
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
    nextMessageSeq: sourceSession.nextMessageSeq,
    nextBlockId: sourceSession.nextBlockId,
    contextFrontier: sourceSession.contextFrontier ? structuredClone(sourceSession.contextFrontier) : undefined,
    parentSessionId: realSourceSessionId,
    currentNode: options?.node || sourceSession.currentNode || 'master',
    agent: sourceSession.agent,
    verbose: sourceSession.verbose,
    model: resolveSpawnedSessionModel(sourceSession, options?.model),
    childModelDefault: sourceSession.childModelDefault,
  };

  const appendedForkMessages: Message[] = [];

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
      appendedForkMessages.push({
        role: 'tool',
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
  appendedForkMessages.push({
    role: 'user',
    parts: [systemPart(formatSessionIdentityHint({ parentSessionId: realSourceSessionId, sessionId: newSessionId, variant: 'inherited' }))],
    __meta: { timestamp: Date.now() }
  });

  const systemMessage = isChildSession
    ? `You are a child session forked from parent session \`${realSourceSessionId}\`. Your current session ID is \`${newSessionId}\`. ${buildChildCompletionInstruction(realSourceSessionId)}`
    : `Session forked from ${realSourceSessionId} by user command. Your current session ID is \`${newSessionId}\`.`;

  appendedForkMessages.push({
    role: 'user',
    parts: [systemPart(systemMessage)],
    __meta: { timestamp: Date.now() }
  });

  // Add a model acknowledgment to prevent LLM from re-processing inherited history
  if (isChildSession) {
    appendedForkMessages.push({
      role: 'model',
      parts: [{ text: 'Understood. I am a child session. Waiting for task from parent session.' }],
      __meta: { timestamp: Date.now() }
    });
  }

  sessions.set(newSessionId, forkedSession);

  await ensureSessionBranch(newSessionId, {
    parentSessionId: realSourceSessionId,
    forkMessageSeq: Math.max(0, (sourceSession.nextMessageSeq || 1) - 1),
    forkBlockId: Math.max(0, (sourceSession.nextBlockId || 1) - 1),
  });
  await appendSessionMessages(forkedSession, appendedForkMessages);

  logger.info({ sourceSessionId: realSourceSessionId, newSessionId, isChildSession }, 'Session forked');

  return newSessionId;
}

/**
 * Create a child session (for multi-agent)
 * @param parentSessionId Parent session ID
 * @param suffix Suffix for the new session ID
 * @param fork Whether to fork (inherit context) or create new
 * @returns New child session ID
 */
export function resolveSpawnedSessionModel(
  session?: Pick<Session, 'model' | 'childModelDefault'>,
  explicitModel?: string,
): string | undefined {
  const normalizedExplicit = typeof explicitModel === 'string' && explicitModel.trim()
    ? explicitModel.trim()
    : undefined;
  if (normalizedExplicit !== undefined) {
    return normalizedExplicit;
  }

  const childDefault = typeof session?.childModelDefault === 'string' && session.childModelDefault.trim()
    ? session.childModelDefault.trim()
    : undefined;
  if (childDefault !== undefined) {
    return childDefault;
  }

  return typeof session?.model === 'string' && session.model.trim()
    ? session.model.trim()
    : undefined;
}

export async function createChildSession(parentSessionId: string, suffix: string, fork: boolean = false, options?: { node?: string; model?: string }): Promise<string> {
  validateChildSessionSuffix(suffix);
  if (fork) {
    // Fork from parent (inherit context)
    return await forkSession(parentSessionId, suffix, true, options);
  } else {
    // Create new empty session
    const parentSession = await getSession(parentSessionId);
    const realParentSessionId = parentSession.id || parentSessionId;
    const childSessionId = await allocateChildSessionId(realParentSessionId, suffix);

    const agentName = parentSession.agent || 'main';
    const snapshot = await llm.buildSessionSystemPromptSnapshot({
      agentName,
      sessionId: childSessionId,
      systemPromptFiles: parentSession.systemPromptFiles,
    });
    const newSession: Session = {
      id: childSessionId,
      agent: agentName,
      history: [],
      systemPromptFiles: parentSession.systemPromptFiles ? [...parentSession.systemPromptFiles] : undefined,
      persistentMemorySnapshot: snapshot,
      // Non-fork children start a fresh model-facing prefix, so they should not
      // share the parent's prompt-cache routing key. Forked children do share it
      // because their inherited prefix begins with the parent's existing history.
      promptCacheKey: llm.generatePromptCacheKey(),
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
      nextMessageSeq: 1,
      parentSessionId: realParentSessionId,
      currentNode: options?.node || parentSession.currentNode || 'master',
      model: resolveSpawnedSessionModel(parentSession, options?.model),
      childModelDefault: parentSession.childModelDefault,
    };

    const initialMessage: Message = {
      role: 'user',
      parts: [systemPart(`${formatSessionIdentityHint({ parentSessionId: realParentSessionId, sessionId: childSessionId, variant: 'new-child' })}\nYou are a child session (new, empty context). ${buildChildCompletionInstruction(realParentSessionId)}`)],
      __meta: { timestamp: Date.now() }
    };

    sessions.set(childSessionId, newSession);
    await appendSessionMessage(newSession, initialMessage);

    logger.info({ parentSessionId: realParentSessionId, childSessionId, fork: false }, 'Child session created');
    return childSessionId;
  }
}

export async function setSessionParent(childSessionId: string, parentSessionId?: string): Promise<{
  childSessionId: string;
  parentSessionId?: string;
  previousParentSessionId?: string;
}> {
  return sessionRelations.setSessionParent({
    getExistingSession,
    saveSession,
    saveSessionsMetadata,
    notifySessionListUpdated,
  }, childSessionId, parentSessionId);
}

export async function updateChildSessionParentIds(oldParentSessionId: string, newParentSessionId: string): Promise<string[]> {
  return sessionRelations.updateChildSessionParentIds({
    saveSession,
    saveSessionsMetadata,
    getSessionsMap: getAllSessions,
    notifySessionListUpdated,
  }, oldParentSessionId, newParentSessionId);
}

export async function sendToSession(targetSessionId: string, message: string, fromSessionId?: string): Promise<{ requestedSessionId: string; resolvedSessionId: string }> {
  return await sessionRelations.sendToSession({
    getExistingSession,
    getAgentMetadata,
    enqueueSessionItem,
  }, targetSessionId, message, fromSessionId);
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

    // Update message count in metadata
    session.meta.messageCount = session.history.length;

    // Ensure sessions directory exists
    await fs.ensureDir(SESSIONS_DIR);

    // Save history, persistentMemorySnapshot, parentSessionId, indexingState, historyVersion, displayName, currentNode, agent to separate file
    const historyFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
    await fs.ensureDir(path.dirname(historyFile));
    await writeSessionHistoryAtomically(sessionId, serializeSessionHistoryPayload(session));
    
    // Save metadata (lightweight operation)
    await saveSessionsMetadata();

    // Schedule archive-based vector indexing (non-blocking)
    const latestSeqHint = Math.max(0, (session.nextMessageSeq || 1) - 1);
    const latestBlockIdHint = Math.max(0, (session.nextBlockId || 1) - 1);
    const lastMessage = session.history[session.history.length - 1];
    const latestMessageTokenEstimate = lastMessage?.__meta?.seq === latestSeqHint
      ? vector.estimateArchiveMessageTokenCount(lastMessage)
      : undefined;

    vector.scheduleSessionArchiveIndex(sessionId, latestSeqHint, latestMessageTokenEstimate, latestBlockIdHint)
      .catch(err => logger.error({ err, sessionId }, 'Failed to schedule archive indexing'));
    
    // Notify global-list and per-session state consumers.
    notifySessionUpdated(sessionId);
  } catch (e) {
    logger.error({ err: e, sessionId }, 'Failed to save session');
  }
}

/**
 * Save sessions metadata (sessions.json)
 */
export async function saveSessionsMetadata(): Promise<void> {
  try {
    const { data: snapshot, source } = await loadSessionsMetadataSnapshot();
    const data: any = { sessions: {} };
    const existingSessions = snapshot?.sessions && typeof snapshot.sessions === 'object'
      ? snapshot.sessions
      : {};

    for (const [sessionId, metadata] of Object.entries(existingSessions)) {
      if (sessions.has(sessionId) || await fs.pathExists(getSessionHistoryFilePath(sessionId))) {
        const { promptCacheKey: _legacyPromptCacheKey, ...metadataWithoutPromptCacheKey } = (metadata || {}) as Record<string, any>;
        data.sessions[sessionId] = metadataWithoutPromptCacheKey;
      }
    }

    for (const [sessionId, session] of sessions.entries()) {
      data.sessions[sessionId] = stripSessionMetadataForSave(session);
    }

    if (source !== SESSIONS_FILE) {
      logger.warn({ source, inMemorySessionCount: sessions.size, savedSessionCount: Object.keys(data.sessions).length }, 'Saving sessions metadata using recovered baseline');
    }

    await writeSessionsMetadataAtomically(data);
  } catch (e) {
    logger.error(e, 'Failed to save metadata');
  }
}

export async function loadSessions(): Promise<void> {
  try {
    // Load agent metadata first
    await sessionAgentMetadata.loadAgentMetadata();
    await loadChannels();

    const migrationResults = await runStartupMigrations();
    for (const migrationResult of migrationResults) {
      if (!migrationResult.skippedByVersion && (migrationResult.migratedFiles > 0 || migrationResult.failedFiles > 0)) {
        const { failures: _failures, ...migrationSummary } = migrationResult;
        logger.info({ migrationSummary }, 'Startup migration finished');
      }
    }

    const { data, source } = await loadSessionsMetadataSnapshot();
    if (source !== SESSIONS_FILE) {
      logger.warn({ source }, 'Recovering sessions metadata from fallback source');
      await writeSessionsMetadataAtomically(data);
    }

    // Load sessions metadata only (history will be loaded on-demand)
    const sessionsData = data.sessions || data;
    for (const sessionId in sessionsData) {
      // Skip channelAttachments key if it exists in old format
      if (sessionId === 'channelAttachments') continue;

      const metadata = sessionsData[sessionId];
      const { promptCacheKey: _legacyPromptCacheKey, ...metadataWithoutPromptCacheKey } = (metadata || {}) as Record<string, any>;

      // Create session with metadata but empty history (will be loaded when getSession is called)
      const session: Session = {
        id: sessionId,
        busy: false,
        meta: { lastMessageTime: Date.now() },
        ...metadataWithoutPromptCacheKey,
        persistentMemorySnapshot: metadataWithoutPromptCacheKey.persistentMemorySnapshot || '',
        stats: metadataWithoutPromptCacheKey.stats || { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
        systemPromptFiles: llm.normalizeSystemPromptFiles(metadataWithoutPromptCacheKey.systemPromptFiles),
        history: [], // Empty, will be loaded when getSession is called
        queue: metadataWithoutPromptCacheKey.queue || [],
      };

      delete (session as any).isolated;

      sessions.set(sessionId, session);
    }

    // Load channel attachments (migrated to channels.json)
    if (data.channelAttachments) {
      await sessionChannels.importLegacyChannelAttachments(data.channelAttachments);
    }

    logger.info({ sessionCount: sessions.size, attachmentCount: sessionChannels.getAllAttachments().size }, 'Session metadata loaded');
  } catch (e) {
    logger.error(e, 'Failed to load sessions');
  }
}

export async function forceIndexSession(sessionId: string): Promise<void> {
  await sessionHistory.forceIndexSession(getSessionHistoryDeps(), sessionId);
}

export async function compactHistory(sessionId: string, keepPercent: number = COMPACT_PERCENT, completionMarker: string = 'Compaction completed.'): Promise<void> {
  await sessionHistory.compactHistory(getSessionHistoryDeps(), sessionId, keepPercent, completionMarker);
}

export async function compactHistoryWithSummary(sessionId: string, summary: string, keepPercent: number = COMPACT_PERCENT, completionMarker: string = 'Manual compaction completed.'): Promise<void> {
  await sessionHistory.compactHistoryWithSummary(getSessionHistoryDeps(), sessionId, summary, keepPercent, completionMarker);
}

export async function deleteMessages(sessionId: string, num: number): Promise<{ deleted: number; remaining: number }> {
  return sessionHistory.deleteMessages(getSessionHistoryDeps(), sessionId, num);
}

export async function clearSession(sessionId: string): Promise<void> {
  await sessionHistory.clearSession(getSessionHistoryDeps(), sessionId);
}

export function getUsageTotalTokens(finalUsage?: Partial<TokenUsage> & {
  cachedContentTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}): number {
  return sessionHistory.getUsageTotalTokens(finalUsage);
}

export async function checkAndCompactIfNeeded(sessionId: string, finalUsage?: Partial<TokenUsage>) {
  await sessionHistory.checkAndCompactIfNeeded(getSessionHistoryDeps(), sessionId, finalUsage);
}

export function getAllSessions(): Map<string, Session> {
  return sessions;
}

export function getAllAttachments(): Map<string, sessionChannels.ChannelConfig> {
  return sessionChannels.getAllAttachments();
}

/**
 * Set callback to be called when a session event is queued to an idle session
 */
export function setSessionTriggerCallback(onTrigger: (sessionId: string) => void | Promise<void>): void {
  onSessionTriggered = onTrigger;
}

export async function triggerSessionProcessing(sessionId: string): Promise<void> {
  await Promise.resolve(onSessionTriggered?.(sessionId));
}

function isQueuedSystemEventItem(
  item: QueueItem | undefined,
  message: string,
  type: 'background' | 'trigger' | 'onboot',
): boolean {
  if (!item || item.type !== type || item.source || item.message || !item.parts || item.parts.length !== 1) {
    return false;
  }

  const [part] = item.parts;
  return typeof part?.system === 'string' && part.system === formatSystemPartForModel(message);
}

export function hasTrailingQueuedSystemEvent(
  queue: QueueItem[] | undefined,
  message: string,
  type: 'background' | 'trigger' | 'onboot',
): boolean {
  if (!queue?.length) {
    return false;
  }

  return isQueuedSystemEventItem(queue[queue.length - 1], message, type);
}

function buildManagedInboxWakeupMessage(managedSessionId: string, pendingCount: number): string {
  return `Managed session \`${managedSessionId}\` has ${pendingCount} pending inbox item(s). Use session_step(...) to process them or release_managed_session(...) to hand control back.`;
}

async function reclaimManagedSessionIfStale(session: Session): Promise<boolean> {
  const managed = getManagedSessionState(session);
  if (!managed) {
    return false;
  }

  const ownerSession = await getExistingSession(managed.ownerSessionId);
  const ownerMissing = !ownerSession;
  const expired = isManagedSessionLeaseExpired(managed);

  if ((!ownerMissing && !expired) || session.busy) {
    return false;
  }

  const restoredPending = managed.pendingInbox.map(cloneQueueItem);
  setManagedSessionState(session, null);
  session.queue = [...restoredPending, ...(session.queue || [])];
  await saveSession(session.id);
  return true;
}

async function maybeWakeManagedSessionOwner(session: Session, managed: ManagedSessionState): Promise<void> {
  if (!managed.pendingInbox.length) {
    return;
  }

  const ownerSession = await getExistingSession(managed.ownerSessionId);
  if (!ownerSession) {
    return;
  }

  const now = Date.now();
  if (managed.lastOwnerWakeupAt && now - managed.lastOwnerWakeupAt < MANAGED_OWNER_WAKEUP_COOLDOWN_MS) {
    return;
  }

  const wakeupMessage = buildManagedInboxWakeupMessage(session.id, managed.pendingInbox.length);
  if (hasTrailingQueuedSystemEvent(ownerSession.queue, wakeupMessage, 'background')) {
    managed.lastOwnerWakeupAt = now;
    managed.leaseTouchedAt = now;
    setManagedSessionState(session, managed);
    await saveSession(session.id);
    return;
  }

  managed.lastOwnerWakeupAt = now;
  managed.leaseTouchedAt = now;
  setManagedSessionState(session, managed);
  await saveSession(session.id);
  await queueSessionSystemEvent(managed.ownerSessionId, wakeupMessage, 'background');
}

async function maybeResumeManagedSessionControllerRun(session: Session, managed: ManagedSessionState): Promise<boolean> {
  if (!managed.controllerRunId || !managed.pendingInbox.length) {
    return false;
  }
  try {
    const toolscript = require('./toolscript') as {
      resumeBackgroundToolScriptRunForManagedSession?: (args: {
        runId: string;
        sessionId: string;
        leaseId?: string;
        revision?: number;
        pendingInboxCount?: number;
        wakeReason?: string;
      }) => Promise<any>;
    };
    const resumed = await toolscript.resumeBackgroundToolScriptRunForManagedSession?.({
      runId: managed.controllerRunId,
      sessionId: session.id,
      leaseId: managed.leaseId,
      revision: managed.revision,
      pendingInboxCount: managed.pendingInbox.length,
      wakeReason: 'managed-inbox',
    });
    return !!resumed;
  } catch (error: any) {
    logger.warn({ err: error, sessionId: session.id, controllerRunId: managed.controllerRunId }, 'Failed to resume managed-session ToolScript controller run');
    return false;
  }
}

export async function enqueueSessionItem(sessionId: string, item: QueueItem): Promise<void> {
  const session = await getSession(sessionId);
  await reclaimManagedSessionIfStale(session);
  const managedBeforeEnqueue = !!getManagedSessionState(session);

  const waitTransition = applyQueuedItemToWaitState(session, item);
  if (waitTransition.action === 'drop') {
    return;
  }
  if (waitTransition.action === 'defer') {
    await saveSession(sessionId);
    return;
  }

  const itemsToEnqueue = waitTransition.items;
  if (itemsToEnqueue.length === 0) {
    await saveSession(sessionId);
    return;
  }

  const managedInboxItems: QueueItem[] = [];
  const directQueueItems: QueueItem[] = [];
  for (const queuedItem of itemsToEnqueue) {
    if (shouldRouteQueueItemToManagedInbox(session, queuedItem)) {
      managedInboxItems.push(queuedItem);
    } else {
      directQueueItems.push(queuedItem);
    }
  }

  if (managedInboxItems.length > 0) {
    const managed = getManagedSessionState(session);
    if (!managed) {
      throw new Error(`Managed session metadata missing for session \`${sessionId}\`.`);
    }

    managed.pendingInbox.push(...managedInboxItems.map(cloneQueueItem));
    managed.lastInboxAt = Date.now();
    managed.leaseTouchedAt = managed.lastInboxAt;
    managed.revision += 1;
    setManagedSessionState(session, managed);
    await saveSession(sessionId);
    const resumedControllerRun = await maybeResumeManagedSessionControllerRun(session, managed);
    if (!resumedControllerRun) {
      await maybeWakeManagedSessionOwner(session, managed);
    }
  }

  if (directQueueItems.length > 0) {
    session.queue.push(...directQueueItems);
    await saveSession(sessionId);

    if (!managedBeforeEnqueue && !session.busy) {
      void onSessionTriggered?.(sessionId);
    }
  }
}

export async function requestSessionCompaction(
  sessionId: string,
  options: {
    compactGuidance?: string;
    keepPercent?: number;
    completionMarker?: string;
    stopAfterCurrentTurn?: boolean;
    requestedBy?: 'auto' | 'command' | 'tool' | 'manual';
  } = {}
): Promise<{ alreadyQueued: boolean; startedImmediately: boolean; queueLength: number }> {
  const session = await getSession(sessionId);

  if (session.queue.some(item => item.type === 'compact' || item.type === 'compact-commit') || sessionHistory.hasPendingCompactWork(sessionId)) {
    return {
      alreadyQueued: true,
      startedImmediately: false,
      queueLength: session.queue.length,
    };
  }

  const startedImmediately = !getManagedSessionState(session) && !session.busy && session.queue.length === 0;
  if (startedImmediately) {
    // Idle sessions do not need a synthetic queue item just to enter the compact
    // runner. Keep the `compact` item only for busy/managed sessions where it is
    // still the ordering marker for "compact after the current turn/step".
    await updateSessionBusyState(session, true);

    void (async () => {
      try {
        await processSessionCompactionRequest(sessionId, {
          keepPercent: options.keepPercent,
          compactGuidance: options.compactGuidance,
          completionMarker: options.completionMarker,
        }, 'auto');
      } catch (error: any) {
        logger.error({ err: error, sessionId }, 'Immediate session compaction failed');
        if (session.broadcast) {
          session.broadcast(`Error: ${error?.message || 'Compaction failed'}`);
        }
      } finally {
        await updateSessionBusyState(session, false);
        if (session.queue.length > 0) {
          void onSessionTriggered?.(sessionId);
        }
      }
    })();

    return {
      alreadyQueued: false,
      startedImmediately: true,
      queueLength: session.queue.length,
    };
  }

  await enqueueSessionItem(sessionId, {
    type: 'compact',
    keepPercent: options.keepPercent,
    compactGuidance: options.compactGuidance,
    completionMarker: options.completionMarker,
    stopAfterCurrentTurn: options.stopAfterCurrentTurn,
    requestedBy: options.requestedBy,
  });

  return {
    alreadyQueued: false,
    startedImmediately,
    queueLength: session.queue.length,
  };
}

export async function processSessionCompactionRequest(
  sessionId: string,
  item: Pick<QueueItem, 'keepPercent' | 'compactGuidance' | 'completionMarker'>,
  executionMode: 'auto' | 'await' | 'background' = 'auto'
): Promise<void> {
  await sessionHistory.processSessionCompactionRequest(getSessionHistoryDeps(), sessionId, item, executionMode);
}

export async function applyCompletedCompactJob(sessionId: string): Promise<boolean> {
  return sessionHistory.applyCompletedCompactJob(getSessionHistoryDeps(), sessionId);
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
    parts: [{
      system: formatFoxwarmMessage({
        type,
        eventType: type,
        hint: `${type} session event`,
      }, message),
    }],
  });
}

export async function queueSessionStructuredEvent(sessionId: string, parts: MessagePart[], type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type,
    parts: parts.map(part => ({ ...part }))
  });
}

export async function queueSessionMessageEvent(sessionId: string, message: Message, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type,
    message: structuredClone(message),
  });
}

export async function queueSessionSystemEvent(sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  await queueSessionStructuredEvent(sessionId, buildSystemMessageParts(message), type);
}

/**
 * Notify history update (for SSE broadcasting)
 */
export function notifyHistoryUpdate(sessionId: string, message: Message) {
  if (onHistoryUpdated) {
    onHistoryUpdated(sessionId, message);
  }
}

export function notifySessionEvent(sessionId: string, event: SessionStreamEvent) {
  if (onSessionEventUpdated) {
    onSessionEventUpdated(sessionId, event);
  }
}

export async function appendSessionMessages(sessionOrId: Session | string, messages: Message[], options: { suppressGoalReminder?: boolean } = {}): Promise<void> {
  const session = typeof sessionOrId === 'string'
    ? await getSession(sessionOrId)
    : sessionOrId;

  if (messages.length === 0) {
    return;
  }

  await appendMessagesToArchive(session, messages);

  for (const message of messages) {
    session.history.push(message);
  }
  appendMessagesToContextFrontier(session, messages);

  const messagesToNotify = [...messages];
  const goalReminderMessage = options.suppressGoalReminder ? undefined : maybeBuildGoalReminderMessage(session);

  await saveSession(session.id);

  for (const message of messagesToNotify) {
    notifyHistoryUpdate(session.id, message);
  }

  if (goalReminderMessage) {
    await queueSessionMessageEvent(session.id, goalReminderMessage, 'background');
  }
}

export async function appendSessionMessage(sessionOrId: Session | string, message: Message): Promise<void> {
  await appendSessionMessages(sessionOrId, [message]);
}

export async function notifyManualForkCreated(parentSessionId: string, childSessionId: string, initialMessage?: string): Promise<'appended' | 'queued'> {
  const parent = await getSession(parentSessionId);
  const messageText = initialMessage === undefined
    ? formatFoxwarmSystem({
      kind: 'session-event',
      event: 'manual-fork-created',
      currentSessionId: parent.id,
      childSessionId,
      initialMessage: '(none)',
    }, `User manually created fork child session \`${childSessionId}\` from the current session \`${parent.id}\`.\nInitial message: (none)`)
    : `${formatFoxwarmSystemOpen({
      kind: 'session-event',
      event: 'manual-fork-created',
      currentSessionId: parent.id,
      childSessionId,
    })}\nUser manually created fork child session \`${childSessionId}\` from the current session \`${parent.id}\`.\nInitial message:\n${initialMessage}\n${formatFoxwarmSystemClose()}`;
  const notification: Message = {
    role: 'user',
    parts: [systemPart(messageText)],
    __meta: { timestamp: Date.now() },
  };

  if (parent.busy) {
    await queueSessionMessageEvent(parent.id, notification, 'background');
    return 'queued';
  }

  await appendSessionMessages(parent, [notification], { suppressGoalReminder: true });
  return 'appended';
}


/**
 * Get list of all session IDs with basic info
 */
export function listSessions(): Array<{ id: string; messageCount: number; lastMessageTime: number | null; hasChannel: boolean; displayName?: string; currentNode?: string; cwd?: string; isolated?: boolean; busy?: boolean; queueLength?: number; parentSessionId?: string; runtimeState: SessionRuntimeState }> {
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
      cwd: session.cwd,
      isolated: isSessionEffectivelyIsolated(session),
      busy: session.busy,
      queueLength: session.queue?.length || 0,
      parentSessionId: session.parentSessionId,
      runtimeState: buildSessionRuntimeState(session)
    });
  }
  
  return result.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
}

export async function setSessionCwd(sessionId: string, cwd?: string): Promise<{ changed: boolean; previous?: string; current?: string }> {
  const session = await getSession(sessionId);
  const previous = typeof session.cwd === 'string' && session.cwd.trim().length > 0 ? session.cwd : undefined;
  const next = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined;

  if (previous === next) {
    return { changed: false, previous, current: next };
  }

  if (next) {
    session.cwd = next;
  } else {
    delete session.cwd;
  }

  await saveSession(session.id);
  return { changed: true, previous, current: next };
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

export async function getArchivedMessages(sessionId: string, options: {
  startSeq?: number;
  endSeq?: number;
} = {}) {
  return sessionHistory.getArchivedMessages(sessionId, options);
}

export async function getArchivedBlocks(sessionId: string, options: {
  startId?: number;
  endId?: number;
} = {}) {
  const records = await readArchiveBlocksByIdRange(sessionId, options.startId, options.endId);
  return {
    records,
    totalMatched: records.length,
    returnedCount: records.length,
    requestedRange: { startId: options.startId, endId: options.endId },
  };
}

export async function compactSessionToolMessages(sessionId: string, keepPercent: number = COMPACT_PERCENT, thresholdTokens?: number) {
  return sessionHistory.compactToolMessages(getSessionHistoryDeps(), sessionId, keepPercent, thresholdTokens);
}

export function getDefaultCompactThresholdTokens(session: Pick<Session, 'model'>): number {
  return sessionHistory.getDefaultCompactThresholdTokens(session);
}

export function getEffectiveCompactThresholdTokens(session: Pick<Session, 'model' | 'compactThresholdTokens'>): number {
  return sessionHistory.getEffectiveCompactThresholdTokens(session);
}

export async function setSessionChildModelDefault(sessionId: string, childModelDefault?: string): Promise<{
  sessionId: string;
  childModelDefault?: string;
  inherited: boolean;
  effectiveModel?: string;
}> {
  const session = await getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  const normalized = typeof childModelDefault === 'string' && childModelDefault.trim()
    ? childModelDefault.trim()
    : undefined;

  if (normalized !== undefined) {
    session.childModelDefault = normalized;
  } else {
    delete session.childModelDefault;
  }

  await saveSession(session.id);

  return {
    sessionId: session.id,
    childModelDefault: session.childModelDefault,
    inherited: typeof session.childModelDefault !== 'string',
    effectiveModel: resolveSpawnedSessionModel(session),
  };
}

export async function setSessionCompactThreshold(sessionId: string, thresholdTokens?: number): Promise<{
  sessionId: string;
  thresholdTokens?: number;
  inherited: boolean;
  effectiveThresholdTokens: number;
}> {
  const session = await getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  if (typeof thresholdTokens === 'number') {
    if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) {
      throw new Error('compact threshold must be a positive number of tokens.');
    }
    session.compactThresholdTokens = Math.floor(thresholdTokens);
  } else {
    delete session.compactThresholdTokens;
  }

  await saveSession(session.id);

  return {
    sessionId: session.id,
    thresholdTokens: session.compactThresholdTokens,
    inherited: typeof session.compactThresholdTokens !== 'number',
    effectiveThresholdTokens: getEffectiveCompactThresholdTokens(session),
  };
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  clearActiveSessionRuntimeState(sessionId);

  if (!sessions.has(sessionId)) {
    return false;
  }

  sessionHistory.discardPendingCompactWork(sessionId);
  
  // Remove from memory
  sessions.delete(sessionId);
  
  // Remove channel attachments
  sessionChannels.detachChannelsForSession(sessionId);
  
  // Delete session file
  const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (await fs.pathExists(sessionFile)) {
    await fs.remove(sessionFile);
  }

  const legacyFrontierFile = getLegacySessionFrontierPath(sessionId);
  if (await fs.pathExists(legacyFrontierFile)) {
    await fs.remove(legacyFrontierFile);
  }
  
  // Save metadata
  await saveSessionsMetadata();
  await saveChannels();
  
  // Notify global-list and per-session state consumers.
  notifySessionUpdated(sessionId);
  
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
  
  // Notify global-list and per-session state consumers.
  notifySessionUpdated(sessionId);
  
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

  // Trigger session processing without adding model-visible retry text.
  logger.info({ sessionId }, 'Retrying session');
  await enqueueSessionItem(sessionId, { type: 'retry' });
}

/**
 * Resume busy sessions after restart
 * Called during startup to reactivate sessions that were interrupted
 */
export async function resumeBusySessions(): Promise<void> {
  const busySessionIds: string[] = [];
  const queuedSessionIds: string[] = [];
  const managedPendingSessionIds: string[] = [];

  // Check metadata for busy or queued sessions (no need to load history files)
  for (const [sessionId, session] of sessions.entries()) {
    if (session.busy === true) {
      busySessionIds.push(sessionId);
      continue;
    }

    if ((session.queue?.length || 0) > 0) {
      queuedSessionIds.push(sessionId);
    }

    const managed = getManagedSessionState(session as Session);
    if (managed?.pendingInbox?.length) {
      managedPendingSessionIds.push(sessionId);
    }
  }

  if (busySessionIds.length === 0 && queuedSessionIds.length === 0 && managedPendingSessionIds.length === 0) {
    logger.info({ busyCount: 0, queuedCount: 0, managedPendingCount: 0, busySessions: busySessionIds, queuedSessions: queuedSessionIds, managedPendingSessions: managedPendingSessionIds }, 'Resuming sessions after restart');
    return;
  }

  logger.info({ busyCount: busySessionIds.length, queuedCount: queuedSessionIds.length, managedPendingCount: managedPendingSessionIds.length, busySessions: busySessionIds, queuedSessions: queuedSessionIds, managedPendingSessions: managedPendingSessionIds }, 'Resuming sessions after restart');

  for (const sessionId of busySessionIds) {
    try {
      // Get session (will load history if needed)
      const session = await getSession(sessionId);
      // Reset busy flag and trigger
      session.busy = false;
      session.busyStartedAt = undefined;
      const resumeMessage = 'session resumed after process restart';
      if (hasTrailingQueuedSystemEvent(session.queue, resumeMessage, 'background')) {
        await saveSession(sessionId);
        onSessionTriggered?.(sessionId);
      } else {
        // Will save session inside, no need to call saveSession() here.
        await queueSessionSystemEvent(sessionId, resumeMessage, 'background');
      }
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

  for (const sessionId of managedPendingSessionIds) {
    try {
      const session = await getSession(sessionId);
      if (await reclaimManagedSessionIfStale(session)) {
        if (!session.busy && session.queue.length > 0) {
          onSessionTriggered?.(sessionId);
        }
        continue;
      }

      const managed = getManagedSessionState(session);
      if (managed) {
        const resumedControllerRun = await maybeResumeManagedSessionControllerRun(session, managed);
        if (!resumedControllerRun) {
          await maybeWakeManagedSessionOwner(session, managed);
        }
      }
      logger.info({ sessionId }, 'Managed session inbox wakeup processed after restart');
    } catch (e) {
      logger.error({ err: e, sessionId }, 'Failed to process managed session inbox after restart');
    }
  }
}
