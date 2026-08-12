/**
 * Session Manager - manages sessions independently of channels
 * A session can be attached to multiple channels
 */

import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { CompactionRequest, isQueueItem, Session, Message, MessagePart, QueueItem, TokenUsage, SessionStreamEvent } from './types';
import { logger } from './common';
import { ChannelFile, ChannelSendFileOptions } from './channel';
import * as llm from './llm';
import { RpcError } from './rpc';
import { buildChildCompletionInstruction } from './session/childSessionReminder';
import { cloneQueueItem, getManagedSessionState, isManagedSessionLeaseExpired, ManagedSessionState, setManagedSessionState, shouldRouteQueueItemToManagedInbox } from './session/managedState';
import * as vector from './vector';
import { VECTOR_ENABLED } from './config';
import { CATALOG_DB_PATH, CHANNELS_FILE, SESSIONS_DIR, COMPACT_PERCENT, getAgentDir, getLegacySessionFrontierPath, type ModelEffort, type ModelsConfig } from './config';
import * as sessionAgentOps from './session/agentOps';
import * as sessionAgentMetadata from './session/agentMetadata';
import { appendMessagesToArchive, ensureMessageSeq, getNextSessionMessageSeq } from './session/archive';
import { externalizeMessages, externalizeQueueItemImages } from './imageBlobs';
import { annotateHistoryWithContextFrontierMetadata, appendMessagesToContextFrontier, readArchiveBlocksByIdRange, renderHistoryFromFrontier } from './session/layeredContext';
import { ensureSessionBranch, hasArchivedSessionId, rollbackUncommittedSessionArchive } from './session/archiveStore';
import { getSessionHistoryFilePath, loadSessionsMetadataSnapshot, readSessionHistorySnapshot, withSessionsMetadataWriteLock } from './session/metadataStore';
import { buildSessionCatalogProjection, readLegacyChannelAttachmentsFromCatalogMigrationEvidence, sessionCatalogStore } from './session/catalogStore';
import { externalizeAuthoritativeSessionImages, externalizeAuthoritativeSessionQueueImages, writeAuthoritativeSessionState } from './session/stateFile';
import { replaceAuthoritativeSessionState } from './session/stateHydration';
import * as sessionChannels from './session/channels';
import * as sessionHistory from './session/history';
import { applyNormalizedSessionModelEffortSettings, normalizeProspectiveSessionModelEffortSettings } from './session/modelEffortSettings';
import * as sessionRelations from './session/relations';
import { formatSessionIdentityHint } from './session/identityHint';
import { buildTimestampedSystemMessageParts, withInputTimePart } from './utils/systemMessageParts';
import { formatLocalTimestamp } from './utils/localTime';
import { formatFoxwarmMessage, formatFoxwarmSystem, formatFoxwarmSystemClose, formatFoxwarmSystemOpen, formatFoxwarmSystemTag, parseFoxwarmOpeningTag, parseFoxwarmTagLine, formatSystemPartForModel } from './utils/promptWrappers';
import { runStartupMigrations } from './migrations';
import {
  buildSessionRuntimeState,
  clearSessionCatalogStub,
  clearActiveSessionRuntimeState,
  formatSessionRuntimeStateSummary,
  getEffectiveSessionQueueLength,
  markSessionCatalogStub,
  setActiveSessionRuntimeState,
  setSessionRuntimeStateUpdateCallback,
  type ActiveSessionRuntimeStateInput,
  type SessionRuntimeState,
} from './sessionRuntimeState';

function systemPart(system: string): MessagePart {
  return { system: formatSystemPartForModel(system) };
}

const MANAGED_OWNER_WAKEUP_COOLDOWN_MS = 30 * 1000;
const SESSION_WORKER_PROCESS = !!process.env.FOXWARM_SESSION_WORKER_SESSION_ID;

let sessionIdentityLockTail: Promise<void> = Promise.resolve();
const channelSessionCreationTails = new Map<string, Promise<void>>();
const pendingAuthoritativeStateUpgrades = new Set<string>();

async function withSessionIdentityLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = sessionIdentityLockTail;
  let release!: () => void;
  sessionIdentityLockTail = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Serializes one concrete Session-worker admission against destructive claim
 * acquisition. The callback must end once the effect is durably admitted
 * (owner ensured plus mailbox append, or activated call accepted); it must not
 * await a provider/tool turn to finish.
 */
export async function withSessionDestructiveMutationAdmission<T>(
  sessionIds: Array<string | undefined>,
  operation: string,
  admit: () => Promise<T>,
): Promise<T> {
  return withSessionIdentityLock(async () => {
    assertSessionDestructiveMutationAllowed(sessionIds, operation);
    return admit();
  });
}

async function withChannelSessionCreationLock<T>(channelId: string, conversationId: string, operation: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([channelId, conversationId]);
  const previous = channelSessionCreationTails.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  channelSessionCreationTails.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (channelSessionCreationTails.get(key) === current) {
      channelSessionCreationTails.delete(key);
    }
  }
}

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

export type WaitQueueTransition =
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
  // This item represents internal compaction maintenance, not external input.
  // It may be processed while a session is waiting, but should not consume the
  // wait token or make a later wait-timeout event stale.
  return item.type === 'compact-commit';
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
    parts: buildTimestampedSystemMessageParts(buildWaitAllPendingReminder(pendingSessions)),
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

export function applyQueuedItemToWaitState(session: Session, item: QueueItem): WaitQueueTransition {
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
  return startSessionWaitForSession(session, options, () => saveSession(session.id));
}

export async function startSessionWaitForSession(session: Session, options: {
  reason?: string;
  timeoutSeconds?: number;
  waitAllSessions?: string[];
  waitExecIds?: string[];
} = {}, persistSession: () => Promise<void>): Promise<SessionWaitState> {
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
  await persistSession();
  return state;
}

export async function clearSessionWaitById(sessionId: string | undefined, waitId: string): Promise<boolean> {
  if (!sessionId) return false;
  const session = await getExistingSession(sessionId);
  const wait = getSessionWaitState(session);
  if (!session || !wait || wait.id !== waitId) return false;
  clearSessionWaitState(session);
  await saveSession(session.id);
  return true;
}

export async function queueSessionWaitTimeoutEvent(sessionId: string, waitId: string, message: string): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type: 'background',
    parts: buildTimestampedSystemMessageParts(message),
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

  return SESSION_WORKER_PROCESS || !sessionCatalogStore.exists() ? false : !!sessionCatalogStore.get(sessionId);
}

async function getSessionIdReservation(sessionId: string): Promise<SessionIdReservation> {
  const resolvedSessionId = await resolveSessionId(sessionId);
  if (resolvedSessionId !== sessionId) {
    if (await hasPersistedLiveSessionId(resolvedSessionId)) {
      return 'live';
    }
    return await hasArchivedSessionId(sessionId) ? 'archived' : null;
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

async function generateAvailableSessionName(agentName: string = 'main'): Promise<string> {
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

const destructiveLifecycleClaims = new Map<string, string>();
let destructiveLifecycleClaimSequence = 0;

export class SessionDestructiveLifecycleClaimError extends Error {
  readonly code = 'SESSION_DELETE_IN_PROGRESS';
  readonly statusCode = 409;
  readonly retryable = true;

  constructor(sessionId: string, operation: string) {
    super(`Session "${sessionId}" is being prepared for deletion and cannot ${operation}. Retry after the delete request finishes.`);
    this.name = 'SessionDestructiveLifecycleClaimError';
  }
}

export function resolveLoadedSessionId(sessionId: string): string {
  if (sessions.has(sessionId)) return sessionId;
  const cached = aliasCache.get(sessionId);
  if (cached) {
    const target = sessions.get(cached);
    if (!target?.aliases?.includes(sessionId)) aliasCache.delete(sessionId);
  }
  if (SESSION_WORKER_PROCESS || !sessionCatalogStore.exists()) return sessionId;
  const resolution = sessionCatalogStore.resolveId(sessionId);
  if (resolution.kind !== 'alias' || !resolution.sessionId) return sessionId;
  aliasCache.set(sessionId, resolution.sessionId);
  return resolution.sessionId;
}

/**
 * Return the already-loaded catalog/session stub without filesystem lookup or
 * semantic hydration. Main-owned presentation and permission checks use this
 * boundary when Session-worker placement owns the full state.
 */
export function getSessionCatalog(sessionId: string): Session | undefined {
  return sessions.get(resolveLoadedSessionId(sessionId));
}

export function isSessionDestructiveLifecycleClaimed(sessionId: string): boolean {
  return destructiveLifecycleClaims.has(resolveLoadedSessionId(sessionId));
}

export function assertSessionDestructiveMutationAllowed(
  sessionIds: Array<string | undefined>,
  operation: string,
  owningClaimId?: string,
): void {
  for (const sessionId of sessionIds) {
    if (!sessionId) continue;
    const realId = resolveLoadedSessionId(sessionId);
    const claimId = destructiveLifecycleClaims.get(realId);
    if (claimId && claimId !== owningClaimId) {
      throw new SessionDestructiveLifecycleClaimError(realId, operation);
    }
  }
}

export async function claimSessionsForDestructiveLifecycle(sessionIds: string[]): Promise<{ claimId: string; sessionIds: string[] }> {
  return withSessionIdentityLock(async () => {
    const canonicalIds = [...new Set(sessionIds.map(resolveLoadedSessionId))];
    assertSessionDestructiveMutationAllowed(canonicalIds, 'start another destructive lifecycle action');
    const claimId = `delete-${process.pid}-${Date.now()}-${++destructiveLifecycleClaimSequence}`;
    for (const sessionId of canonicalIds) destructiveLifecycleClaims.set(sessionId, claimId);
    return { claimId, sessionIds: canonicalIds };
  });
}

export function releaseSessionsForDestructiveLifecycle(claimId: string): void {
  const releasedSessionIds: string[] = [];
  for (const [sessionId, ownerClaimId] of destructiveLifecycleClaims) {
    if (ownerClaimId !== claimId) continue;
    destructiveLifecycleClaims.delete(sessionId);
    releasedSessionIds.push(sessionId);
  }
  for (const sessionId of releasedSessionIds) {
    const session = sessions.get(sessionId);
    if (session && !session.busy && session.queue.some(isQueueItem)) {
      try {
        void Promise.resolve(onSessionTriggered?.(sessionId)).catch(error => {
          logger.error({ err: error, sessionId }, 'Failed to resume queued work after destructive lifecycle claim release');
        });
      } catch (error) {
        logger.error({ err: error, sessionId }, 'Failed to resume queued work after destructive lifecycle claim release');
      }
    }
  }
}

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

  if (SESSION_WORKER_PROCESS) return sessionId;
  if (!sessionCatalogStore.exists()) await sessionCatalogStore.initialize();

  const resolution = sessionCatalogStore.resolveId(sessionId);
  if (resolution.kind === 'alias' && resolution.sessionId) {
    aliasCache.set(sessionId, resolution.sessionId);
    return resolution.sessionId;
  }

  // Not an alias, return as-is
  return sessionId;
}

// Check if a session exists in memory or on disk (metadata)
export async function getExistingSession(sessionId: string): Promise<Session | null> {
  return withSessionIdentityLock(() => getExistingSessionUnlocked(sessionId));
}

async function getExistingSessionUnlocked(sessionId: string): Promise<Session | null> {
  // Resolve alias first
  const realId = await resolveSessionId(sessionId);
  
  const session = sessions.get(realId);
  if (session) {
    // Sessions loaded from catalog.sqlite start as metadata-only placeholders
    // with an empty history array. Delegate to getSession() so callers that
    // later save or inspect the session do not accidentally operate on an
    // unloaded placeholder and overwrite the on-disk history.
    return await getSessionUnlocked(realId);
  }

  // Check if session history file exists
  const historyFile = path.join(SESSIONS_DIR, `${realId}.json`);
  if (await fs.pathExists(historyFile)) {
    // Load metadata + history via getSession
    return await getSessionUnlocked(realId);
  }

  if (!SESSION_WORKER_PROCESS && sessionCatalogStore.get(realId)) return await getSessionUnlocked(realId);

  return null;
}

export type ChannelMode = sessionChannels.ChannelMode;

// Callback to trigger agent turn
let onSessionTriggered: ((sessionId: string) => void | Promise<void>) | null = null;
let onSessionRetryRequested: ((sessionId: string) => void | Promise<void>) | null = null;

// Callback when history is updated (for SSE broadcasting)
let onHistoryUpdated: ((sessionId: string, message: Message) => void) | null = null;

// Callback when transient session events are updated (for SSE broadcasting)
let onSessionEventUpdated: ((sessionId: string, event: SessionStreamEvent) => void) | null = null;

// Independent callbacks for global-list consumers and one-session consumers.
// The WebUI sidebar/architecture owns the former; each Chat stream owns the
// latter and never needs to refetch the full list for runtime state.
let onSessionListUpdated: (() => void) | null = null;
let onSessionStateUpdated: ((sessionId: string) => void) | null = null;
let sessionPersistenceFaultInjector: ((phase: 'history' | 'metadata', sessionId?: string) => void) | null = null;

export function setSessionPersistenceFaultInjectorForTests(injector: ((phase: 'history' | 'metadata', sessionId?: string) => void) | null): void {
  sessionPersistenceFaultInjector = injector;
}

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
  if (workerDeleteHandler) await workerDeleteHandler(sessionId);
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
  return withSessionIdentityLock(() => getSessionUnlocked(sessionId));
}

async function getSessionUnlocked(sessionId: string, persistNew: boolean = true): Promise<Session> {
  // Resolve alias first
  const realId = await resolveSessionId(sessionId);
  
  let session = sessions.get(realId);
  let isNew = false;
  let needsAuthoritativeStateUpgrade = pendingAuthoritativeStateUpgrades.has(realId);
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
  if (!isNew && (session.history.length === 0 || needsAuthoritativeStateUpgrade)) {
    // Try to load history and persistentMemorySnapshot from file
    const historyFile = path.join(SESSIONS_DIR, `${realId}.json`);
    if (await fs.pathExists(historyFile)) {
      try {
        const historyData = await readSessionHistorySnapshot(realId);
        if (!historyData) {
          throw new Error('Session history file disappeared during read');
        }
        const retryPendingUpgrade = needsAuthoritativeStateUpgrade;
        // displayName is Main-owned presentation metadata: preserve the Main
        // value (including an explicit clear) across authoritative rehydration.
        needsAuthoritativeStateUpgrade = replaceAuthoritativeSessionState(session, historyData, { preserveCatalogFields: true }).upgradedLegacy || retryPendingUpgrade;
        clearSessionCatalogStub(session);
        delete (session as any).managedPendingCount;
        if (needsAuthoritativeStateUpgrade) pendingAuthoritativeStateUpgrades.add(realId);
        if (historyData.indexingState) {
          // Check if indexing was interrupted
          await resumeIndexingIfNeeded(sessionId, session);
        }
        logger.debug({ sessionId: realId, messageCount: session.history.length }, 'Session history loaded from file');
      } catch (e) {
        logger.error({ err: e, sessionId }, 'Failed to load session history');
        throw e;
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

  try {
    if (await externalizeAuthoritativeSessionImages(session) || needsAuthoritativeStateUpgrade) {
      await saveSessionCritical(session.id);
      pendingAuthoritativeStateUpgrades.delete(realId);
    }
  } catch (error) {
    if (needsAuthoritativeStateUpgrade) throw error;
    // Legacy bytes remain intact in memory/on disk when blob materialization
    // fails. Transport/provider boundaries retain their own tolerant readers.
    logger.warn({ err: error, sessionId: session.id }, 'Failed to externalize legacy session images during lazy hydration');
  }

  // Setup broadcast function
  if (!session.broadcast) {
    setupSessionBroadcast(sessionId);
  }

  if (isNew && persistNew) {
    try {
      await saveSessionCritical(realId);
    } catch (error) {
      await rollbackFailedSessionCreation(realId, session);
      throw error;
    }
  }

  return session;
}

export async function createEmptySession(sessionId?: string): Promise<{ session: Session; created: boolean }> {
  return withSessionIdentityLock(() => createEmptySessionUnlocked(sessionId));
}

async function createEmptySessionUnlocked(sessionId?: string): Promise<{ session: Session; created: boolean }> {
  const targetSessionId = sessionId || await allocateGeneratedSessionId();
  const existingSession = await getExistingSessionUnlocked(targetSessionId);
  if (existingSession) {
    return { session: existingSession, created: false };
  }

  await assertSessionIdAvailableForNewLifetime(targetSessionId);

  const session = await getSessionUnlocked(targetSessionId, false);
  try {
    await saveSessionCritical(session.id);
  } catch (error) {
    await rollbackFailedSessionCreation(session.id, session);
    throw error;
  }
  return { session, created: true };
}

export async function updateSessionBusyState(session: Session, busy: boolean): Promise<void> {
  if (busy) assertSessionDestructiveMutationAllowed([session.id], 'start new work');
  await updateSessionBusyStateForSession(
    session,
    busy,
    () => saveSessionCatalogEntries([session.id]),
    clearActiveSessionRuntimeState,
    notifySessionUpdated,
  );
}

export async function updateSessionBusyStateForSession(
  session: Session,
  busy: boolean,
  persistSession: () => Promise<void>,
  clearRuntimeState: (sessionId: string) => void = clearActiveSessionRuntimeState,
  notifySession?: (sessionId: string) => void,
  shouldRollbackPersistFailure: (error: unknown) => boolean = () => true,
): Promise<void> {
  const previousBusy = session.busy;
  const hadBusyStartedAt = Object.prototype.hasOwnProperty.call(session, 'busyStartedAt');
  const previousBusyStartedAt = session.busyStartedAt;
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
    session.busyStartedAt = undefined;
  }

  if (!changed && !busyStartedChanged) {
    if (!busy) clearRuntimeState(session.id);
    return;
  }

  try {
    await persistSession();
  } catch (error) {
    if (shouldRollbackPersistFailure(error)) {
      session.busy = previousBusy;
      if (hadBusyStartedAt) session.busyStartedAt = previousBusyStartedAt;
      else delete session.busyStartedAt;
    }
    throw error;
  }
  if (!busy) clearRuntimeState(session.id);
  notifySession?.(session.id);
}

export function notifySessionStateUpdated(sessionId: string): void {
  notifySessionUpdated(sessionId);
}

/**
 * Create a new session with given data
 */
export async function createSession(sessionId: string, sessionData: any): Promise<void> {
  await withSessionIdentityLock(() => createSessionUnlocked(sessionId, sessionData));
}

async function createSessionUnlocked(sessionId: string, sessionData: any): Promise<void> {
  await assertSessionIdAvailableForNewLifetime(sessionId);
  assertSessionDestructiveMutationAllowed([sessionData?.parentSessionId], 'receive a new child session');
  if (sessionData && typeof sessionData === 'object') {
    delete sessionData.isolated;
    llm.ensurePromptCacheKey(sessionData as Session);
  }
  sessions.set(sessionId, sessionData);
  try {
    await saveSessionCritical(sessionId);
  } catch (error) {
    await rollbackFailedSessionCreation(sessionId, sessionData);
    throw error;
  }
  logger.info({ sessionId }, 'Session created');
}

async function rollbackFailedSessionCreation(sessionId: string, expectedSession: Session): Promise<void> {
  if (sessions.get(sessionId) === expectedSession) sessions.delete(sessionId);
  await fs.remove(getSessionHistoryFilePath(sessionId)).catch(() => {});
  await rollbackUncommittedSessionArchive(sessionId).catch(error => {
    logger.error({ err: error, sessionId }, 'Failed to roll back uncommitted session archive');
  });
  await saveSessionCatalogEntriesCritical([sessionId]).catch(error => {
    logger.error({ err: error, sessionId }, 'Failed to persist session-creation rollback');
  });
}

async function saveChannels(): Promise<void> {
  await sessionChannels.saveChannels();
}

async function saveChannelsCritical(): Promise<void> {
  await sessionChannels.saveChannelsCritical();
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

function getSessionAgentOpsDeps(underIdentityLock: boolean = false) {
  return {
    getSession: underIdentityLock ? getSessionUnlocked : getSession,
    getExistingSession: underIdentityLock ? getExistingSessionUnlocked : getExistingSession,
    assertSessionIdAvailableForNewLifetime,
    createSession: underIdentityLock ? createSessionUnlocked : createSession,
    saveSession: underIdentityLock ? saveSessionCritical : saveSession,
    saveSessionCatalogEntries: underIdentityLock ? saveSessionCatalogEntriesCritical : saveSessionCatalogEntries,
    saveChannels: underIdentityLock ? saveChannelsCritical : saveChannels,
    updateAliasCache,
    updateChildSessionParentIds: underIdentityLock ? updateChildSessionParentIdsCritical : updateChildSessionParentIds,
    moveSessionArchiveIndex: vector.renameSessionArchiveIndex,
    getAgentMetadata,
    getSessionsMap: getAllSessions,
    getAttachmentsMap: getAllAttachments,
    assertSessionMutationAllowed: assertSessionDestructiveMutationAllowed,
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
  try {
    onSessionListUpdated?.();
  } catch (error) {
    logger.error({ err: error }, 'Session list update callback failed');
  }
}

function notifySessionUpdated(sessionId: string) {
  notifySessionListUpdated();
  try {
    onSessionStateUpdated?.(sessionId);
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Session state update callback failed');
  }
}

setSessionRuntimeStateUpdateCallback((sessionId) => notifySessionUpdated(sessionId));

export { buildSessionRuntimeState, clearActiveSessionRuntimeState, formatSessionRuntimeStateSummary, setActiveSessionRuntimeState };
export type { ActiveSessionRuntimeStateInput, SessionRuntimeState };

function getAgentMetadataDeps(underIdentityLock: boolean = false) {
  return {
    getSession: underIdentityLock ? getSessionUnlocked : getSession,
    getExistingSession: underIdentityLock ? getExistingSessionUnlocked : getExistingSession,
    saveSession: underIdentityLock ? saveSessionCritical : saveSession,
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
  assertAgentMetadataMutationAllowed('Agent inheritance changes');
  return sessionAgentMetadata.setAgentInherit(getAgentMetadataDeps(), agentName, inheritAgentName);
}

export async function setAgentIsolation(agentName: string, isolatedNode?: string): Promise<{ affectedSessions: string[]; isolated: boolean; node?: string }> {
  assertAgentMetadataMutationAllowed('Agent isolation changes');
  return sessionAgentMetadata.setAgentIsolation(getAgentMetadataDeps(), agentName, isolatedNode);
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
  effort?: ModelEffort;
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
  if (options.sourceSessionOverride && options.sourceSessionId
    && options.sourceSessionOverride.id !== options.sourceSessionId
    && !options.sourceSessionOverride.aliases?.includes(options.sourceSessionId)) {
    throw new RpcError('SESSION_WORKER_ADMIN_SOURCE_MISMATCH', 'Detached agent-creation source does not match sourceSessionId.');
  }
  if (workerEnqueueSink && (options.convertSessionId || (options.sourceSessionId && !options.sourceSessionOverride))) {
    throw new RpcError('SESSION_WORKER_ADMIN_UNSUPPORTED', 'Creating an agent from or by converting an existing session is unavailable while Session-worker placement is enabled.', true);
  }
  const { inherit, isolatedNode, ...createOptions } = options;
  const normalizedInherit = inherit && String(inherit).trim() ? String(inherit).trim() : undefined;
  const normalizedIsolatedNode = isolatedNode && String(isolatedNode).trim() ? String(isolatedNode).trim() : undefined;

  if (normalizedInherit !== undefined) {
    validateAgentName(normalizedInherit);
    if (!await fs.pathExists(getAgentDir(normalizedInherit))) {
      throw new Error(`Inherited agent "${normalizedInherit}" does not exist.`);
    }
  }

  return withSessionIdentityLock(async () => {
    const result = await sessionAgentOps.createAgentWithMainSession(createOptions, getSessionAgentOpsDeps(true));
    if (normalizedIsolatedNode !== undefined) {
      await sessionAgentMetadata.setAgentIsolation(getAgentMetadataDeps(true), options.agentName, normalizedIsolatedNode);
    }
    if (normalizedInherit !== undefined) {
      await sessionAgentMetadata.setAgentInherit(getAgentMetadataDeps(true), options.agentName, normalizedInherit);
    }
    return result;
  });
}

export async function createSessionInAgent(options: {
  agentName: string;
  sessionName?: string;
  displayName?: string;
  currentNode?: string;
  model?: string;
  effort?: ModelEffort;
  modelsConfig?: ModelsConfig;
  parentSessionId?: string;
  systemPromptFiles?: string[];
}): Promise<{ sessionId: string }> {
  return withSessionIdentityLock(async () => {
    const sessionName = options.sessionName === undefined
      ? await generateAvailableSessionName(options.agentName)
      : options.sessionName;
    return sessionAgentOps.createSessionInAgent({ ...options, sessionName }, getSessionAgentOpsDeps(true));
  });
}

export async function createSessionInAgentWithAutomaticName(
  options: Omit<Parameters<typeof sessionAgentOps.createSessionInAgent>[0], 'sessionName'>,
  generateName: () => string,
): Promise<{ sessionId: string }> {
  return withSessionIdentityLock(async () => {
    while (true) {
      const sessionName = generateName();
      const sessionId = options.agentName === 'main' ? sessionName : `${options.agentName}/${sessionName}`;
      if (await isSessionIdReserved(sessionId)) {
        continue;
      }
      return sessionAgentOps.createSessionInAgent({ ...options, sessionName }, getSessionAgentOpsDeps(true));
    }
  });
}

export async function moveSessionToTarget(options: {
  sourceSessionId: string;
  newSessionId?: string;
  createAgent?: boolean;
  newAgentName?: string;
  createAgentInheritMemory?: boolean;
  parentSessionId?: string;
}): Promise<{
  oldSessionId: string;
  targetSessionId: string;
  targetAgent: string;
  createdAgent: boolean;
  aliases: string[];
  updatedChildren: string[];
  previousParentSessionId?: string;
  parentSessionId?: string;
  requestedParentSessionId?: string;
  parentUpdateError?: string;
}> {
  if (workerEnqueueSink) {
    throw new RpcError('SESSION_WORKER_ADMIN_UNSUPPORTED', 'Session identity move/rename is unavailable while Session-worker placement is enabled.', true);
  }
  let previousParentSessionId: string | undefined;
  let requestedParentSessionId: string | undefined;
  const parentWasProvided = options.parentSessionId !== undefined;
  const requestedParentInput = options.parentSessionId?.trim();
  if (parentWasProvided && !requestedParentInput) {
    throw new Error('parentSessionId must be a non-empty existing session ID when provided. Use the explicit unparent operation to detach.');
  }
  const result = await withSessionIdentityLock(async () => {
    const sourceSession = await getExistingSessionUnlocked(options.sourceSessionId);
    if (!sourceSession) throw new Error(`Session "${options.sourceSessionId}" not found.`);
    previousParentSessionId = sourceSession.parentSessionId || undefined;
    requestedParentSessionId = parentWasProvided
      ? (await sessionRelations.resolveSessionParentId({ getExistingSession: getExistingSessionUnlocked }, sourceSession.id, requestedParentInput)).parentSessionId
      : undefined;
    assertSessionDestructiveMutationAllowed([sourceSession.id, requestedParentSessionId], 'move or rename');
    return sessionAgentOps.moveSessionToTarget(options, getSessionAgentOpsDeps(true));
  });

  let parentSessionId = (await getExistingSession(result.targetSessionId))?.parentSessionId || undefined;
  let parentUpdateError: string | undefined;
  if (parentWasProvided && parentSessionId !== requestedParentSessionId) {
    try {
      const parentResult = await setSessionParent(result.targetSessionId, requestedParentSessionId);
      parentSessionId = parentResult.parentSessionId;
    } catch (error: any) {
      parentSessionId = (await getExistingSession(result.targetSessionId))?.parentSessionId || undefined;
      parentUpdateError = error?.message || String(error);
    }
  }

  return {
    ...result,
    previousParentSessionId,
    parentSessionId,
    ...(parentWasProvided ? { requestedParentSessionId } : {}),
    ...(parentUpdateError ? { parentUpdateError } : {}),
  };
}

/**
 * Attach a channel to a session
 * @param channelId Configured channel instance id (for legacy configs this is usually the same as the channel type)
 * @param conversationId Channel-side conversation/chat/room target id
 * @param sessionId Existing session ID to attach
 * @returns The session ID
 */
export function attachChannel(channelId: string, conversationId: string, sessionId: string, configUpdates?: Partial<sessionChannels.ChannelConfig>): string {
  assertSessionDestructiveMutationAllowed([sessionId], 'accept a new channel attachment');
  return sessionChannels.attachChannel(channelId, conversationId, sessionId, configUpdates);
}

export async function attachChannelDurably(channelId: string, conversationId: string, sessionId: string, configUpdates?: Partial<sessionChannels.ChannelConfig>): Promise<string> {
  assertSessionDestructiveMutationAllowed([sessionId], 'accept a new channel attachment');
  return sessionChannels.attachChannelDurably(channelId, conversationId, sessionId, configUpdates);
}

export async function getOrCreateSessionForChannel(
  channelId: string,
  conversationId: string,
  options?: {
    createSession?: () => Promise<{ session: Session; created: boolean }>;
    attachmentConfig?: Partial<sessionChannels.ChannelConfig>;
    hydrateExisting?: boolean;
  },
): Promise<{ sessionId: string; session: Session }> {
  return withChannelSessionCreationLock(channelId, conversationId, async () => {
    const existingSessionId = getSessionByChannel(channelId, conversationId);
    if (existingSessionId) {
      const session = options?.hydrateExisting === false
        ? getSessionCatalog(existingSessionId)
        : await getSession(existingSessionId);
      if (!session) throw new Error(`Session \`${existingSessionId}\` is not loaded.`);
      return { sessionId: existingSessionId, session };
    }

    const created = options?.createSession
      ? await options.createSession()
      : await createEmptySession();
    const createdSession = created.session;
    const concurrentlyAttachedSessionId = getSessionByChannel(channelId, conversationId);
    if (concurrentlyAttachedSessionId) {
      if (created.created) await rollbackFailedSessionCreation(createdSession.id, createdSession);
      await saveChannelsCritical();
      return {
        sessionId: concurrentlyAttachedSessionId,
        session: options?.hydrateExisting === false
          ? (() => {
              const session = getSessionCatalog(concurrentlyAttachedSessionId);
              if (!session) throw new Error(`Session \`${concurrentlyAttachedSessionId}\` is not loaded.`);
              return session;
            })()
          : await getSession(concurrentlyAttachedSessionId),
      };
    }

    try {
      const sessionId = await attachChannelDurably(channelId, conversationId, createdSession.id, options?.attachmentConfig);
      return { sessionId, session: createdSession };
    } catch (error) {
      if (created.created) await rollbackFailedSessionCreation(createdSession.id, createdSession);
      throw error;
    }
  });
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
  return sessionChannels.sendFileToSession({ getExistingSession: async id => getSessionCatalog(id) || null }, sessionId, file, options);
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

export function collectSessionDescendants(sessionId: string): { descendantIds: string[]; directChildIds: string[]; postOrderIds: string[] } {
  return sessionRelations.collectSessionDescendants(sessions, sessionId);
}

export function getCanonicalChildSessionIds(parentSessionId: string): string[] {
  return sessionRelations.getCanonicalChildSessionIds(sessions, parentSessionId);
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
export async function forkSession(sourceSessionId: string, suffix?: string, isChildSession: boolean = false, options?: { node?: string; model?: string; effort?: ModelEffort; sourceOverride?: Session }): Promise<string> {
  return withSessionIdentityLock(() => forkSessionUnlocked(sourceSessionId, suffix, isChildSession, options));
}

async function forkSessionUnlocked(sourceSessionId: string, suffix?: string, isChildSession: boolean = false, options?: { node?: string; model?: string; effort?: ModelEffort; sourceOverride?: Session }): Promise<string> {
  assertSessionDestructiveMutationAllowed([sourceSessionId], 'receive a new fork session');
  // sourceOverride lets a trusted caller (e.g. the Main management facade)
  // supply a detached read-only snapshot of a worker-owned authority instead
  // of hydrating it into Main. Overrides are never persisted back.
  const detachedSource = options?.sourceOverride || await workerForkSourceProvider?.(sourceSessionId);
  const sourceSession = detachedSource || await getSessionUnlocked(sourceSessionId);
  const realSourceSessionId = sourceSession.id || sourceSessionId;
  const newSessionId = await allocateForkSessionId(realSourceSessionId, suffix, isChildSession);
  const sourcePreviousPromptCacheKey = sourceSession.promptCacheKey;
  const promptCacheKey = llm.ensurePromptCacheKey(sourceSession);
  if (sourceSession.promptCacheKey !== sourcePreviousPromptCacheKey && !detachedSource) {
    await saveSession(sourceSession.id);
  }
  const spawnedSettings = resolveSpawnedSessionModelEffort(sourceSession, options?.model, options?.effort);

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
    model: spawnedSettings.model,
    effort: spawnedSettings.effort,
    childModelDefault: sourceSession.childModelDefault,
    childEffortDefault: sourceSession.childEffortDefault,
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
    parts: [systemPart(formatSessionIdentityHint({ parentSessionId: realSourceSessionId, sessionId: newSessionId, variant: 'inherited', timestamp: Date.now() }))],
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

  assertSessionDestructiveMutationAllowed([realSourceSessionId], 'receive a new fork session');
  sessions.set(newSessionId, forkedSession);
  try {
    await ensureSessionBranch(newSessionId, {
      parentSessionId: realSourceSessionId,
      forkMessageSeq: Math.max(0, (sourceSession.nextMessageSeq || 1) - 1),
      forkBlockId: Math.max(0, (sourceSession.nextBlockId || 1) - 1),
    });
    await appendSessionMessages(forkedSession, appendedForkMessages, { strictPersistence: true });
  } catch (error) {
    await rollbackFailedSessionCreation(newSessionId, forkedSession);
    throw error;
  }

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

export function resolveSpawnedSessionEffort(
  session?: Pick<Session, 'effort' | 'childEffortDefault'>,
  explicitEffort?: ModelEffort,
): ModelEffort | undefined {
  return explicitEffort ?? session?.childEffortDefault ?? session?.effort;
}

export function resolveSpawnedSessionModelEffort(
  session?: Pick<Session, 'model' | 'effort' | 'childModelDefault' | 'childEffortDefault'>,
  explicitModel?: string,
  explicitEffort?: ModelEffort,
): { model?: string; effort?: ModelEffort } {
  const model = resolveSpawnedSessionModel(session, explicitModel);
  const inheritedEffort = resolveSpawnedSessionEffort(session, explicitEffort);
  const normalized = normalizeProspectiveSessionModelEffortSettings(
    { model, effort: inheritedEffort },
    explicitEffort === undefined ? {} : { effort: explicitEffort },
  );
  return { model: normalized.model, effort: normalized.effort };
}

export async function createChildSession(parentSessionId: string, suffix: string, fork: boolean = false, options?: { node?: string; model?: string; effort?: ModelEffort; sourceOverride?: Session }): Promise<string> {
  return withSessionIdentityLock(() => createChildSessionUnlocked(parentSessionId, suffix, fork, options));
}

async function createChildSessionUnlocked(parentSessionId: string, suffix: string, fork: boolean = false, options?: { node?: string; model?: string; effort?: ModelEffort; sourceOverride?: Session }): Promise<string> {
  validateChildSessionSuffix(suffix);
  assertSessionDestructiveMutationAllowed([parentSessionId], 'receive a new child session');
  if (fork) {
    // Fork from parent (inherit context)
    return await forkSessionUnlocked(parentSessionId, suffix, true, options);
  } else {
    // Create new empty session
    const parentSession = options?.sourceOverride || await getSessionUnlocked(parentSessionId);
    const realParentSessionId = parentSession.id || parentSessionId;
    const childSessionId = await allocateChildSessionId(realParentSessionId, suffix);
    const spawnedSettings = resolveSpawnedSessionModelEffort(parentSession, options?.model, options?.effort);

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
      model: spawnedSettings.model,
      effort: spawnedSettings.effort,
      childModelDefault: parentSession.childModelDefault,
      childEffortDefault: parentSession.childEffortDefault,
    };

    const initialMessage: Message = {
      role: 'user',
      parts: [systemPart(`${formatSessionIdentityHint({ parentSessionId: realParentSessionId, sessionId: childSessionId, variant: 'new-child', timestamp: Date.now() })}\nYou are a child session (new, empty context). ${buildChildCompletionInstruction(realParentSessionId)}`)],
      __meta: { timestamp: Date.now() }
    };

    assertSessionDestructiveMutationAllowed([realParentSessionId], 'receive a new child session');
    sessions.set(childSessionId, newSession);
    try {
      await appendSessionMessages(newSession, [initialMessage], { strictPersistence: true });
    } catch (error) {
      await rollbackFailedSessionCreation(childSessionId, newSession);
      throw error;
    }

    logger.info({ parentSessionId: realParentSessionId, childSessionId, fork: false }, 'Child session created');
    return childSessionId;
  }
}

export async function setSessionParent(childSessionId: string, parentSessionId?: string, owningClaimId?: string): Promise<{
  childSessionId: string;
  parentSessionId?: string;
  previousParentSessionId?: string;
}> {
  // A worker-fenced child's authority is worker-owned: the parent link is
  // Main-owned presentation metadata there, so update it catalog-only and
  // never write the fenced authority (a stale stub write could corrupt it).
  if (workerEnqueueSink || workerFenceChecker?.(childSessionId)) {
    const child = sessions.get(childSessionId);
    if (!child) throw new Error(`Session \`${childSessionId}\` not found.`);
    const previousParentSessionId = child.parentSessionId;
    assertSessionDestructiveMutationAllowed(
      [childSessionId, parentSessionId],
      parentSessionId ? 'change parent relations' : 'detach from its parent',
      owningClaimId,
    );
    child.parentSessionId = parentSessionId;
    await saveSessionCatalogEntries([childSessionId]);
    notifySessionListUpdated();
    return { childSessionId, parentSessionId, previousParentSessionId };
  }
  return sessionRelations.setSessionParent({
    getExistingSession,
    saveSession,
    saveSessionCatalogEntries,
    notifySessionListUpdated,
    assertMutationAllowed: (sessionIds, operation) => assertSessionDestructiveMutationAllowed(sessionIds, operation, owningClaimId),
  }, childSessionId, parentSessionId);
}

export async function updateChildSessionParentIds(oldParentSessionId: string, newParentSessionId: string): Promise<string[]> {
  return sessionRelations.updateChildSessionParentIds({
    // Worker-fenced children keep their authority worker-owned: skip the
    // per-child authority write; the catalog metadata update still lands.
    saveSession: sessionId => (workerEnqueueSink || workerFenceChecker?.(sessionId)) ? Promise.resolve() : saveSession(sessionId),
    saveSessionCatalogEntries,
    getSessionsMap: getAllSessions,
    notifySessionListUpdated,
  }, oldParentSessionId, newParentSessionId);
}

async function updateChildSessionParentIdsCritical(oldParentSessionId: string, newParentSessionId: string): Promise<string[]> {
  const updated: string[] = [];
  for (const [sessionId, session] of sessions) {
    if (session.parentSessionId !== oldParentSessionId) continue;
    session.parentSessionId = newParentSessionId;
    await saveSessionCritical(sessionId);
    updated.push(sessionId);
  }
  if (updated.length > 0) {
    await saveSessionCatalogEntriesCritical(updated);
    notifySessionListUpdated();
  }
  return updated;
}

export async function sendToSession(targetSessionId: string, message: string, fromSessionId?: string): Promise<{ requestedSessionId: string; resolvedSessionId: string }> {
  return await sessionRelations.sendToSession({
    getExistingSession,
    getSessionCatalog,
    getAgentMetadata,
    enqueueSessionItem,
  }, targetSessionId, message, fromSessionId);
}


/**
 * Save a single session's history to its file
 */
export async function saveSession(sessionOrId: Session | string): Promise<void> {
  const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
  try {
    if (typeof sessionOrId === 'string') await saveSessionCritical(sessionId);
    else await saveSessionForSessionCritical(sessionOrId);
  } catch (e) {
    logger.error({ err: e, sessionId }, 'Failed to save session');
  }
}

async function saveSessionCritical(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found for saving.`);
  }

  await saveSessionForSessionCritical(session);
}

async function saveSessionForSessionCritical(session: Session): Promise<void> {
  const sessionId = session.id;
  await saveSessionStateOnlyCritical(session);

  // Save metadata (lightweight operation)
  await saveSessionCatalogEntriesCritical([session.id]);

  // Schedule archive-based vector indexing (non-blocking)
  if (VECTOR_ENABLED) {
    const latestSeqHint = Math.max(0, (session.nextMessageSeq || 1) - 1);
    const latestBlockIdHint = Math.max(0, (session.nextBlockId || 1) - 1);
    const lastMessage = session.history[session.history.length - 1];
    const latestMessageTokenEstimate = lastMessage?.__meta?.seq === latestSeqHint
      ? vector.estimateArchiveMessageTokenCount(lastMessage)
      : undefined;

    vector.scheduleSessionArchiveIndex(sessionId, latestSeqHint, latestMessageTokenEstimate, latestBlockIdHint)
      .catch(err => logger.error({ err, sessionId }, 'Failed to schedule archive indexing'));
  }

  // Notify global-list and per-session state consumers.
  notifySessionUpdated(sessionId);
}

/** Local save composition half; the underlying state-file writer is worker-safe. */
async function saveSessionStateOnlyCritical(session: Session): Promise<void> {
  sessionPersistenceFaultInjector?.('history', session.id);
  await writeAuthoritativeSessionState(session);
}

/** Persist only the named catalog entries. Missing in-memory IDs are deleted. */
export async function saveSessionCatalogEntries(sessionIds: Iterable<string>): Promise<void> {
  try {
    await saveSessionCatalogEntriesCritical(sessionIds);
  } catch (e) {
    logger.error(e, 'Failed to save session catalog entries');
  }
}

async function saveSessionCatalogEntriesCritical(sessionIds: Iterable<string>): Promise<void> {
  // The catalog is an always-Main-owned database. A Session worker persists
  // only its authoritative per-session JSON and publishes a bounded projection
  // for Main to commit during handback.
  if (SESSION_WORKER_PROCESS) return;
  const ids = [...new Set(sessionIds)];
  return withSessionsMetadataWriteLock(async () => {
    if (!sessionCatalogStore.exists()) await sessionCatalogStore.initialize();
    await saveSessionCatalogEntriesCriticalUnlocked(ids);
  });
}

async function saveSessionCatalogEntriesCriticalUnlocked(sessionIds: string[]): Promise<void> {
  sessionPersistenceFaultInjector?.('metadata');
  const upserts: Record<string, any>[] = [];
  const deletes: string[] = [];
  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (!session) { deletes.push(sessionId); continue; }
    await externalizeAuthoritativeSessionQueueImages(session);
    const metadata = buildSessionCatalogProjection(session);
    if (workerFenceChecker?.(sessionId)) {
      const current = sessionCatalogStore.get(sessionId);
      if (current) {
        const catalogOnlyFields = ['id', 'agent', 'aliases', 'parentSessionId', 'displayName', 'archived', 'pinned', 'sidebarOrder'] as const;
        const merged = { ...current };
        for (const field of catalogOnlyFields) {
          if (metadata[field] === undefined) delete merged[field];
          else merged[field] = metadata[field];
        }
        const lastChannel = metadata.meta?.lastChannel;
        if (lastChannel !== undefined) merged.meta = { ...(current.meta || {}), lastChannel };
        upserts.push(merged);
        continue;
      }
    }
    upserts.push(metadata);
  }
  sessionCatalogStore.upsertMany(upserts, deletes);
}

/** Commit the complete bounded projection after an exact Worker handback. */
export async function saveSessionCatalogProjectionStrict(sessionId: string): Promise<void> {
  if (SESSION_WORKER_PROCESS) throw new Error('Session workers cannot write catalog.sqlite.');
  await withSessionsMetadataWriteLock(async () => {
    if (!sessionCatalogStore.exists()) await sessionCatalogStore.initialize();
    const session = sessions.get(sessionId);
    if (!session) { sessionCatalogStore.deleteMany([sessionId]); return; }
    await externalizeAuthoritativeSessionQueueImages(session);
    sessionCatalogStore.upsertMany([buildSessionCatalogProjection(session)]);
  });
}

export async function loadSessions(): Promise<void> {
  // A pending identity move is authoritative data-integrity state. Recovery
  // must finish before ordinary loading and its failure is intentionally fatal.
  const catalogExisted = sessionCatalogStore.exists();
  const identityMoveRecovery = !catalogExisted
    ? await sessionAgentOps.recoverPendingSessionIdentityMove(vector.renameSessionArchiveIndex)
    : 'none';
  if (identityMoveRecovery !== 'none') {
    logger.warn({ identityMoveRecovery }, 'Recovered pending session identity move');
  }
  let catalogMigration;
  let sqliteIdentityMoveRecovery: 'none' | 'finished' | 'rolled-back' = 'none';
  if (catalogExisted) {
    catalogMigration = await sessionCatalogStore.initialize();
    sqliteIdentityMoveRecovery = await sessionAgentOps.recoverPendingSessionIdentityMove(vector.renameSessionArchiveIndex, {
        load: async () => ({ sessions: Object.fromEntries(sessionCatalogStore.list().map(metadata => [metadata.id, metadata])) }),
        replace: async data => sessionCatalogStore.replaceAll(Object.values(data.sessions || data)),
      });
  }
  if (sqliteIdentityMoveRecovery !== 'none') logger.warn({ identityMoveRecovery: sqliteIdentityMoveRecovery }, 'Recovered pending SQLite session identity move');
  // Legacy archive migration still reads sessions.json for the live-ID set.
  // Complete it before the first catalog migration retires that file.
  const migrationResults = await runStartupMigrations();
  for (const migrationResult of migrationResults) {
    if (!migrationResult.skippedByVersion && (migrationResult.migratedFiles > 0 || migrationResult.failedFiles > 0)) {
      const { failures: _failures, ...migrationSummary } = migrationResult;
      logger.info({ migrationSummary }, 'Startup migration finished');
    }
  }
  if (!catalogExisted) catalogMigration = await sessionCatalogStore.initialize();
  logger.info({ ...catalogMigration!, databasePath: CATALOG_DB_PATH }, 'Session catalog initialized');
  try {
    // Load agent metadata first
    await sessionAgentMetadata.loadAgentMetadata();
    const channelsFileExisted = await fs.pathExists(CHANNELS_FILE);
    await loadChannels();

    const legacyChannelAttachments = await readLegacyChannelAttachmentsFromCatalogMigrationEvidence();
    if (!channelsFileExisted && sessionChannels.getAllAttachments().size === 0 && legacyChannelAttachments) {
      await sessionChannels.importLegacyChannelAttachments(legacyChannelAttachments as any);
    }

    const { data } = await loadSessionsMetadataSnapshot();

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
        queue: Array.isArray(metadataWithoutPromptCacheKey.queue)
          ? metadataWithoutPromptCacheKey.queue.filter(isQueueItem)
          : [],
      };

      delete (session as any).isolated;
      markSessionCatalogStub(session, typeof metadataWithoutPromptCacheKey.queueLength === 'number'
        ? metadataWithoutPromptCacheKey.queueLength
        : session.queue.length);
      delete (session as any).queueLength;

      sessions.set(sessionId, session);
    }

    // Load channel attachments (migrated to channels.json)
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

export function setSessionRetryCallback(onRetry: (sessionId: string) => void | Promise<void>): void {
  onSessionRetryRequested = onRetry;
}

export async function triggerSessionProcessing(sessionId: string): Promise<void> {
  assertSessionDestructiveMutationAllowed([sessionId], 'start queued work');
  await Promise.resolve(onSessionTriggered?.(sessionId));
}

function getTrailingQueuedSystemWrapper(item: QueueItem | undefined, type: 'background' | 'trigger' | 'onboot'): string | undefined {
  if (!item || item.type !== type || item.source || item.message || !item.parts || item.parts.length !== 1) {
    return undefined;
  }
  const [part] = item.parts;
  return typeof part?.system === 'string' ? part.system : undefined;
}

export function hasTrailingQueuedResumeEvent(queue: QueueItem[] | undefined): boolean {
  const wrapper = queue?.length ? getTrailingQueuedSystemWrapper(queue[queue.length - 1], 'background') : undefined;
  const tag = parseFoxwarmTagLine(wrapper);
  return tag?.tagName === 'foxwarm-system'
    && !tag.closing
    && tag.attrs.kind === 'event'
    && tag.attrs.type === 'session-resumed';
}

export function hasTrailingQueuedManagedInboxWakeup(queue: QueueItem[] | undefined, managedSessionId: string, pendingCount: number): boolean {
  const wrapper = queue?.length ? getTrailingQueuedSystemWrapper(queue[queue.length - 1], 'background') : undefined;
  const tag = parseFoxwarmOpeningTag(wrapper);
  return tag?.tagName === 'foxwarm-system'
    && tag.attrs.kind === 'managed-session'
    && tag.attrs.event === 'pending-inbox'
    && tag.attrs.managedSessionId === managedSessionId
    && tag.attrs.pendingCount === String(pendingCount);
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

  assertSessionDestructiveMutationAllowed([session.id], 'accept queued work');
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

  const pendingCount = managed.pendingInbox.length;
  const wakeupMessage = buildManagedInboxWakeupMessage(session.id, pendingCount);
  if (hasTrailingQueuedManagedInboxWakeup(ownerSession.queue, session.id, pendingCount)) {
    assertSessionDestructiveMutationAllowed([session.id], 'accept queued work');
    managed.lastOwnerWakeupAt = now;
    managed.leaseTouchedAt = now;
    setManagedSessionState(session, managed);
    await saveSession(session.id);
    return;
  }

  assertSessionDestructiveMutationAllowed([session.id], 'accept queued work');
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

async function enqueueSessionItemForLoadedSession(session: Session, item: QueueItem): Promise<void> {
  const sessionId = session.id;
  item = (await externalizeQueueItemImages(item)).item;
  assertSessionDestructiveMutationAllowed([sessionId], 'accept queued work');
  await reclaimManagedSessionIfStale(session);
  assertSessionDestructiveMutationAllowed([sessionId], 'accept queued work');
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

    assertSessionDestructiveMutationAllowed([sessionId], 'accept queued work');
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
    assertSessionDestructiveMutationAllowed([sessionId], 'accept queued work');
    session.queue.push(...directQueueItems);
    await saveSession(sessionId);

    if (!managedBeforeEnqueue && !session.busy) {
      assertSessionDestructiveMutationAllowed([sessionId], 'start queued work');
      void onSessionTriggered?.(sessionId);
    }
  }
}

let workerEnqueueSink: ((sessionId: string, item: QueueItem) => Promise<void>) | undefined;
let workerDeleteHandler: ((sessionId: string) => Promise<boolean>) | undefined;
let workerForkSourceProvider: ((sessionId: string) => Promise<Session | undefined>) | undefined;
let workerFenceChecker: ((sessionId: string) => boolean) | undefined;

export function setSessionWorkerEnqueueSink(handler: ((sessionId: string, item: QueueItem) => Promise<void>) | undefined): void {
  workerEnqueueSink = handler;
}

/**
 * Registers the Session-worker destructive-lifecycle hook. When set, delete
 * entry points first let the hook tear down any worker fence (interrupt,
 * graceful stop with handback, durable fence/mailbox removal); a hook failure
 * fails the delete closed without touching the authority. Ordinary local
 * delete semantics always run afterwards on the then-inactive session.
 */
export function setSessionWorkerDeleteHandler(handler: ((sessionId: string) => Promise<boolean>) | undefined): void {
  workerDeleteHandler = handler;
}

/**
 * Registers the Session-worker fork source resolver. When set, forkSession
 * derives a worker-fenced source from this read-only detached snapshot instead
 * of hydrating the fenced authority into Main; unfenced sessions resolve to
 * undefined and keep ordinary local semantics.
 */
export function setSessionWorkerForkSourceProvider(provider: ((sessionId: string) => Promise<Session | undefined>) | undefined): void {
  workerForkSourceProvider = provider;
}

/**
 * Registers the Session-worker fence lookup used to keep Main-owned
 * presentation operations (parent moves, relation updates) catalog-only for
 * fenced sessions: their authority is worker-owned and must never be written
 * from Main.
 */
export function setSessionWorkerFenceChecker(checker: ((sessionId: string) => boolean) | undefined): void {
  workerFenceChecker = checker;
}

/** True when the session currently has an active (non-inactive) Session-worker fence. */
export function isSessionWorkerFenced(sessionId: string): boolean {
  return workerFenceChecker?.(sessionId) === true;
}

/**
 * Agent metadata changes refresh prompt snapshots for affected sessions. That
 * refresh is a Session-semantic mutation, so Main must not run it against a
 * worker-owned authority through the catalog stubs.
 */
export function assertAgentMetadataMutationAllowed(operation: string): void {
  if (!workerEnqueueSink) return;
  throw new RpcError('SESSION_WORKER_ADMIN_UNSUPPORTED', `${operation} is unavailable while Session-worker placement is enabled.`, true);
}

export async function enqueueSessionItem(sessionId: string, item: QueueItem): Promise<void> {
  if (workerEnqueueSink) {
    // Session-worker placement: all Main-side producers share one durable
    // ingress boundary. Managed sessions remain explicitly unsupported there;
    // fail closed instead of spawning a worker that must reject them.
    const canonicalSessionId = resolveLoadedSessionId(sessionId);
    assertSessionDestructiveMutationAllowed([canonicalSessionId], 'accept queued work');
    const stub = sessions.get(canonicalSessionId);
    if (stub && getManagedSessionState(stub as Session)) {
      throw new RpcError('SESSION_WORKER_QUEUE_UNSUPPORTED', 'Managed sessions are not supported by Session-worker placement yet.', true);
    }
    await workerEnqueueSink(canonicalSessionId, item);
    return;
  }
  const session = await getSession(sessionId);
  await enqueueSessionItemForLoadedSession(session, item);
}

export async function requestSessionCompaction(
  sessionId: string,
  options: CompactionRequest = {}
): Promise<{ alreadyQueued: boolean; startedImmediately: boolean; runsInBackground?: boolean; backgroundUnavailable?: boolean; queueLength: number }> {
  const session = await getSession(sessionId);
  assertSessionDestructiveMutationAllowed([session.id], 'start compaction work');

  if (session.queue.some(item => item.type === 'compact-commit') || sessionHistory.hasPendingCompactWork(sessionId)) {
    return {
      alreadyQueued: true,
      startedImmediately: false,
      queueLength: session.queue.length,
    };
  }

  if (sessionHistory.isAsyncCompactEnabled(session)) {
    await processSessionCompactionRequest(sessionId, {
      keepPercent: options.keepPercent,
      compactGuidance: options.compactGuidance,
      completionMarker: options.completionMarker,
    }, 'background');
    return {
      alreadyQueued: false,
      startedImmediately: true,
      runsInBackground: true,
      queueLength: session.queue.length,
    };
  }

  const canRunAwaitedNow = !getManagedSessionState(session) && !session.busy && session.queue.length === 0;
  if (canRunAwaitedNow) {
    await updateSessionBusyState(session, true);

    void (async () => {
      try {
        await processSessionCompactionRequest(sessionId, {
          keepPercent: options.keepPercent,
          compactGuidance: options.compactGuidance,
          completionMarker: options.completionMarker,
        }, 'await');
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
      runsInBackground: false,
      queueLength: session.queue.length,
    };
  }

  return {
    alreadyQueued: false,
    startedImmediately: false,
    backgroundUnavailable: true,
    queueLength: session.queue.length,
  };
}

export async function processSessionCompactionRequest(
  sessionId: string,
  item: CompactionRequest,
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
  const now = new Date();
  await enqueueSessionItem(sessionId, {
    type,
    parts: [{
      system: formatFoxwarmMessage({
        type,
        eventType: type,
        time: formatLocalTimestamp(now),
        hint: `${type} session event`,
      }, message),
    }],
  });
}

export async function queueSessionStructuredEvent(sessionId: string, parts: MessagePart[], type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type,
    parts: withInputTimePart(parts)
  });
}

export async function queueSessionMessageEvent(sessionId: string, message: Message, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  const queuedMessage = structuredClone(message);
  if (queuedMessage.role === 'user' && queuedMessage.modelVisible !== false) {
    queuedMessage.parts = withInputTimePart(queuedMessage.parts);
  }
  await enqueueSessionItem(sessionId, {
    type,
    message: queuedMessage,
  });
}

export async function queueSessionSystemEvent(sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
  await enqueueSessionItem(sessionId, {
    type,
    parts: buildTimestampedSystemMessageParts(message),
  });
}

async function queueSessionSystemEventForLoadedSession(session: Session, message: string, type: 'background' | 'trigger' | 'onboot'): Promise<void> {
  await enqueueSessionItemForLoadedSession(session, {
    type,
    parts: buildTimestampedSystemMessageParts(message),
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

export function notifySessionEvent(sessionId: string, event: SessionStreamEvent) {
  if (onSessionEventUpdated) {
    onSessionEventUpdated(sessionId, event);
  }
}

export async function appendSessionMessages(sessionOrId: Session | string, messages: Message[], options: { strictPersistence?: boolean } = {}): Promise<void> {
  const session = typeof sessionOrId === 'string'
    ? await getSession(sessionOrId)
    : sessionOrId;

  await appendSessionMessagesForSession(session, messages, async () => {
    if (options.strictPersistence) await saveSessionForSessionCritical(session);
    else await saveSession(session);
  });
}

export async function appendSessionMessagesForSession(
  session: Session,
  messages: Message[],
  persistSession: () => Promise<void>,
  notifyMessage: (sessionId: string, message: Message) => void = notifyHistoryUpdate,
): Promise<void> {

  if (messages.length === 0) {
    return;
  }

  for (const message of messages) ensureMessageSeq(session, message);
  const canonicalMessages = (await externalizeMessages(messages)).messages;
  await appendMessagesToArchive(session, canonicalMessages);

  for (const message of canonicalMessages) {
    session.history.push(message);
  }
  appendMessagesToContextFrontier(session, canonicalMessages);

  const messagesToNotify = [...canonicalMessages];

  await persistSession();

  for (const message of messagesToNotify) {
    notifyMessage(session.id, message);
  }
}

export async function appendSessionMessage(sessionOrId: Session | string, message: Message): Promise<void> {
  await appendSessionMessages(sessionOrId, [message]);
}

export function buildManualForkNotificationMessage(parentSessionId: string, childSessionId: string, initialMessage?: string): Message {
  const inputTime = formatLocalTimestamp(Date.now());
  const messageText = initialMessage === undefined
    ? formatFoxwarmSystem({
      kind: 'session-event',
      event: 'manual-fork-created',
      currentSessionId: parentSessionId,
      childSessionId,
      time: inputTime,
      initialMessage: '(none)',
    }, `User manually created fork child session \`${childSessionId}\` from the current session \`${parentSessionId}\`.\nInitial message: (none)`)
    : `${formatFoxwarmSystemOpen({
      kind: 'session-event',
      event: 'manual-fork-created',
      currentSessionId: parentSessionId,
      childSessionId,
      time: inputTime,
    })}\nUser manually created fork child session \`${childSessionId}\` from the current session \`${parentSessionId}\`.\nInitial message:\n${initialMessage}\n${formatFoxwarmSystemClose()}`;
  return {
    role: 'user',
    parts: [systemPart(messageText)],
    __meta: { timestamp: Date.now() },
  };
}

export async function notifyManualForkCreated(parentSessionId: string, childSessionId: string, initialMessage?: string): Promise<'appended' | 'queued'> {
  const parent = await getSession(parentSessionId);
  const notification = buildManualForkNotificationMessage(parent.id, childSessionId, initialMessage);

  if (parent.busy) {
    await queueSessionMessageEvent(parent.id, notification, 'background');
    return 'queued';
  }

  await appendSessionMessages(parent, [notification]);
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
      queueLength: getEffectiveSessionQueueLength(session),
      parentSessionId: session.parentSessionId,
      runtimeState: buildSessionRuntimeState(session)
    });
  }
  
  return result.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
}

export function listSessionCatalogPage(limit: number, offset: number = 0): { sessions: Session[]; total: number } {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const boundedOffset = Math.max(0, Math.floor(offset));
  const metadata = sessionCatalogStore.list({ limit: boundedLimit, offset: boundedOffset });
  return {
    sessions: metadata.map(row => sessions.get(row.id)).filter((session): session is Session => !!session),
    total: sessionCatalogStore.count(),
  };
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

  const prospective = normalizeProspectiveSessionModelEffortSettings(session, {
    childModelDefault: normalized ?? null,
  });
  applyNormalizedSessionModelEffortSettings(session, prospective);

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
export async function deleteSession(sessionId: string, owningClaimId?: string): Promise<boolean> {
  assertSessionDestructiveMutationAllowed([sessionId], 'be deleted', owningClaimId);
  if (workerDeleteHandler) await workerDeleteHandler(sessionId);
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
  await saveSessionCatalogEntries([sessionId]);
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
  await saveSessionCatalogEntries([sessionId]);
  
  // Notify global-list and per-session state consumers.
  notifySessionUpdated(sessionId);
  
  return true;
}

export async function archiveSessions(sessionIds: string[], archived: boolean = true): Promise<{
  matchedSessionIds: string[];
  changedSessionIds: string[];
}> {
  const matchedSessionIds: string[] = [];
  const changedSessionIds: string[] = [];

  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (!session) continue;
    matchedSessionIds.push(sessionId);
    if (!!session.archived === archived) continue;
    session.archived = archived;
    changedSessionIds.push(sessionId);
  }

  if (changedSessionIds.length > 0) {
    await saveSessionCatalogEntries(changedSessionIds);
    for (const sessionId of changedSessionIds) notifySessionUpdated(sessionId);
  }

  return { matchedSessionIds, changedSessionIds };
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

  assertSessionDestructiveMutationAllowed([session.id], 'start retry work');

  if (!onSessionRetryRequested) {
    throw new Error('Session retry processing is unavailable');
  }

  // Retry is an immediate execution request, not persisted queue work.
  logger.info({ sessionId }, 'Retrying session');
  await Promise.resolve(onSessionRetryRequested(sessionId));
}

/**
 * Resume busy sessions after restart
 * Called during startup to reactivate sessions that were interrupted
 */
export async function resumeBusySessions(): Promise<void> {
  const busySessionIds: string[] = [];
  const queuedSessionIds: string[] = [];
  const managedPendingSessionIds: string[] = [];

  // The restart candidate set is indexed in catalog.sqlite; only matching
  // lightweight stubs are inspected here.
  for (const metadata of sessionCatalogStore.listRecoveryCandidates()) {
    const sessionId = metadata.id as string;
    const workerPlacement = !!workerEnqueueSink;
    const session = workerPlacement ? sessions.get(sessionId) : await getSession(sessionId).catch((error): Session | undefined => {
      logger.error({ err: error, sessionId }, 'Failed to hydrate restart-recovery candidate');
      return undefined;
    });
    if (!session) continue;
    if (workerPlacement ? metadata.busy === true : session.busy === true) {
      busySessionIds.push(sessionId);
      continue;
    }
    if (workerPlacement ? (metadata.queueLength || 0) > 0 : (session.queue?.length || 0) > 0) {
      queuedSessionIds.push(sessionId);
    }

    const managed = getManagedSessionState(session as Session);
    if (workerPlacement ? (metadata.managedPendingCount || 0) > 0 : !!managed?.pendingInbox?.length) {
      managedPendingSessionIds.push(sessionId);
    }
  }

  if (workerEnqueueSink && (busySessionIds.length > 0 || queuedSessionIds.length > 0 || managedPendingSessionIds.length > 0)) {
    // Session-worker placement owns execution. Residual Main-local busy/queue
    // state (for example left behind when switching from local placement) must
    // never run through the local runner: the local resume path both bypasses
    // the durable ingress boundary and risks double-writing the per-session
    // authority a worker may own. Log loudly and leave execution to the next
    // durable ingress or the pending mailbox resume.
    logger.warn({
      busySessions: busySessionIds,
      queuedSessions: queuedSessionIds,
      managedPendingSessions: managedPendingSessionIds,
    }, 'Session-worker placement is enabled; skipping Main-local restart recovery for residual busy/queued/managed sessions. Their execution is left to the next durable Worker ingress.');
    return;
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
      const resumeMessage = formatFoxwarmSystemTag({
        kind: 'event',
        type: 'session-resumed',
        hint: 'The Foxwarm process restarted while this session was busy. Foxwarm is resuming session processing.',
      });
      if (hasTrailingQueuedResumeEvent(session.queue)) {
        await saveSession(sessionId);
        onSessionTriggered?.(sessionId);
      } else {
        await queueSessionSystemEventForLoadedSession(session, resumeMessage, 'background');
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
