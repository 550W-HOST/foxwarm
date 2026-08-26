import { externalizeMessages } from './imageBlobs';
import {
  defineRpcService,
  rpcEvent,
  rpcMethod,
  RpcError,
  RpcHandlerContext,
  RpcServiceHandler,
} from './rpc';
import * as sessionManager from './sessionManager';
import type { Message, QueueItem, QueueSource, Session, SessionStreamEvent, TokenUsage } from './types';
import { isQueueItem } from './types';
import { getEffectiveSessionQueueLength, type SessionRuntimeState } from './sessionRuntimeState';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';
import type { SessionWorkerProjectionEntry, SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import type { SessionWorkerStore } from './sessionWorkerStore';
import type { SessionWorkerIngressCoordinator, SessionWorkerIngressResult } from './sessionWorkerIngress';
import type { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import { normalizeSessionWorkerIngressRequest } from './sessionWorkerIngress';
import { readDetachedWorkerSession } from './sessionWorkerSnapshot';
import { normalizeSessionTurnDeliverySource } from './sessionTurnDelivery';
import { sessionCatalogStore } from './session/catalogStore';
import { runBtwRequest } from './btw';
import { MODEL_EFFORTS, type ModelEffort } from './config';
import {
  applyNormalizedSessionModelEffortSettings,
  normalizeProspectiveSessionModelEffortSettings,
} from './session/modelEffortSettings';
import type { CompactCancellationResult } from './session/history';

export type SessionRuntimeTokenTotalsDto = {
  cachedTokens: number;
  inputTokens: number;
  outputTokens: number;
  lastUsage: TokenUsage | null;
};

export type SessionRuntimeSessionDto = {
  id: string;
  agent: string;
  aliases: string[];
  busy: boolean;
  busyStartedAt: number | null;
  queueLength: number;
  runtimeState: SessionRuntimeState;
  displayName: string | null;
  archived: boolean;
  currentNode: string;
  cwd: string | null;
  model: string | null;
  effort: ModelEffort | null;
  childModelDefault: string | null;
  childEffortDefault: ModelEffort | null;
  compactThresholdTokens: number | null;
  isolated: boolean;
  parentSessionId: string | null;
  pinned: boolean;
  sidebarOrder: number | null;
  messageCount: number;
  historyVersion: number;
  lastMessageTime: number;
  tokenUsage: SessionRuntimeTokenTotalsDto;
  verbose: boolean;
};

export type SessionRuntimeHistoryDto = {
  session: SessionRuntimeSessionDto;
  messages: Message[];
  queue: QueueItem[];
  persistentMemorySnapshot: string;
};

export type SessionRuntimeSettingsPatchDto = {
  cwd?: string | null;
  model?: string | null;
  effort?: ModelEffort | null;
  childModelDefault?: string | null;
  childEffortDefault?: ModelEffort | null;
  currentNode?: string | null;
  displayName?: string | null;
  compactThresholdTokens?: number | null;
  verbose?: boolean;
};

export type SessionRuntimeSettingsDto = Required<SessionRuntimeSettingsPatchDto>;

export type SessionRuntimeSettingsResultDto = {
  changed: Array<keyof SessionRuntimeSettingsPatchDto>;
  previous: SessionRuntimeSettingsDto;
  current: SessionRuntimeSettingsDto;
  session: SessionRuntimeSessionDto;
};

export type SessionRuntimeDeleteMessagesResultDto = {
  deleted: number;
  remaining: number;
  session: SessionRuntimeSessionDto;
};
export type SessionRuntimeClearHistoryResultDto = {
  cleared: boolean;
  requiresRetry: boolean;
  droppedQueueItems: number;
  abortedInFlight: boolean;
  session: SessionRuntimeSessionDto;
};
export type SessionRuntimeIndexResultDto = {
  latestSeq: number;
  session: SessionRuntimeSessionDto;
};
export type SessionRuntimeSnapshotResultDto = {
  agentName: string;
  session: SessionRuntimeSessionDto;
};
export type SessionRuntimeForkNotificationResultDto = {
  result: 'appended' | 'queued';
};
export type SessionRuntimeBtwResultDto = { text: string; toolDenied: boolean };
export type SessionRuntimeCompactCancellationResultDto = CompactCancellationResult;

export type SessionRuntimeControlAction = 'stop' | 'dequeue' | 'retry';
export type SessionRuntimeControlResultDto = {
  action: SessionRuntimeControlAction;
  abortedInFlight?: boolean;
  queuedItems?: number;
  stoppedCurrent?: boolean;
};
export type SessionRuntimeCompactionResultDto =
  | { kind: 'worker'; completed: true; compacted: boolean; messageCount: number }
  | { kind: 'local'; alreadyQueued: boolean; startedImmediately: boolean; runsInBackground?: boolean; backgroundUnavailable?: boolean; queueLength: number }
  | { kind: 'tool-noise'; result: Awaited<ReturnType<typeof sessionManager.compactSessionToolMessages>> }
  | { kind: 'empty' }
  | { kind: 'unsupported'; message: string };

export type SessionRuntimeEventPayloads = {
  history: { sessionId: string; message: Message };
  stream: { sessionId: string; event: SessionStreamEvent };
  listChanged: Record<string, never>;
  stateChanged: { sessionId: string; session: SessionRuntimeSessionDto | null };
};

export type SessionListProjectionBatchDto = {
  sessions: SessionRuntimeSessionDto[];
  revision: string;
};

export const sessionRuntimeServiceDescriptor = defineRpcService('session-runtime', 10, {
  getSession: rpcMethod<{ sessionId: string }, { session: SessionRuntimeSessionDto | null }>(),
  listSessions: rpcMethod<{ limit?: number; offset?: number }, { sessions: SessionRuntimeSessionDto[]; total: number }>(),
  getSessionListProjections: rpcMethod<{ sessionIds: string[]; includeVolatile?: boolean; currentOwnersOnly?: boolean }, SessionListProjectionBatchDto>(),
  getHistory: rpcMethod<{ sessionId: string }, SessionRuntimeHistoryDto | null>(),
  enqueue: rpcMethod<{ sessionId: string; item: QueueItem }, { accepted: true }>(),
  submitAndRun: rpcMethod<{ sessionId: string; item: QueueItem }, SessionWorkerIngressResult>(),
  requestCompaction: rpcMethod<{ sessionId: string; keepPercent?: number; toolNoise?: boolean }, SessionRuntimeCompactionResultDto>(),
  cancelCompaction: rpcMethod<{ sessionId: string }, SessionRuntimeCompactCancellationResultDto>(),
  runBtw: rpcMethod<{ sessionId: string; message: string }, SessionRuntimeBtwResultDto>(),
  queueEvent: rpcMethod<{
    sessionId: string;
    text: string;
    type?: 'background' | 'trigger' | 'onboot';
  }, { accepted: true }>(),
  updateSettings: rpcMethod<{
    sessionId: string;
    patch: SessionRuntimeSettingsPatchDto;
  }, SessionRuntimeSettingsResultDto>(),
  deleteMessages: rpcMethod<{ sessionId: string; num: number }, SessionRuntimeDeleteMessagesResultDto>(),
  clearHistory: rpcMethod<{ sessionId: string }, SessionRuntimeClearHistoryResultDto>(),
  forceIndex: rpcMethod<{ sessionId: string }, SessionRuntimeIndexResultDto>(),
  refreshSnapshot: rpcMethod<{ sessionId: string }, SessionRuntimeSnapshotResultDto>(),
  notifyManualForkCreated: rpcMethod<{
    parentSessionId: string;
    childSessionId: string;
    initialMessage?: string;
  }, SessionRuntimeForkNotificationResultDto>(),
  control: rpcMethod<{
    sessionId: string;
    action: SessionRuntimeControlAction;
    source?: QueueSource;
  }, SessionRuntimeControlResultDto>(),
  startEvents: rpcMethod<Record<string, never>, { started: true }>(),
  stopEvents: rpcMethod<Record<string, never>, { stopped: true }>(),
}, {
  history: rpcEvent<SessionRuntimeEventPayloads['history']>(),
  stream: rpcEvent<SessionRuntimeEventPayloads['stream']>(),
  listChanged: rpcEvent<SessionRuntimeEventPayloads['listChanged']>(),
  stateChanged: rpcEvent<SessionRuntimeEventPayloads['stateChanged']>(),
});

type SessionRuntimeEventContext = RpcHandlerContext<typeof sessionRuntimeServiceDescriptor.events>;

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('SESSION_RUNTIME_INVALID_SESSION_ID', 'sessionId must be a non-empty string.');
  }
  return value.trim();
}

function settingsFromSession(session: Session): SessionRuntimeSettingsDto {
  return {
    cwd: typeof session.cwd === 'string' && session.cwd.trim() ? session.cwd.trim() : null,
    model: typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null,
    effort: session.effort || null,
    childModelDefault: typeof session.childModelDefault === 'string' && session.childModelDefault.trim()
      ? session.childModelDefault.trim()
      : null,
    childEffortDefault: session.childEffortDefault || null,
    currentNode: typeof session.currentNode === 'string' && session.currentNode.trim() ? session.currentNode.trim() : null,
    displayName: typeof session.displayName === 'string' && session.displayName.trim() ? session.displayName.trim() : null,
    compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
    verbose: !!session.verbose,
  };
}

function normalizeNullableSetting(
  patch: SessionRuntimeSettingsPatchDto,
  key: keyof SessionRuntimeSettingsPatchDto,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return undefined;
  const value = patch[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', `${key} must be a string or null.`);
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeNullableEffortSetting(
  patch: SessionRuntimeSettingsPatchDto,
  key: 'effort' | 'childEffortDefault',
): ModelEffort | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return undefined;
  const value = patch[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !MODEL_EFFORTS.includes(value as ModelEffort)) {
    throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', `${key} must be one of: ${MODEL_EFFORTS.join(', ')}, or null.`);
  }
  return value as ModelEffort;
}

export function buildSessionRuntimeSessionDto(session: Session): SessionRuntimeSessionDto {
  const messageCount = session.meta?.messageCount ?? session.history.length;
  const lastMessage = session.history[session.history.length - 1];
  const lastMessageTime = session.meta?.lastMessageTime
    ?? (typeof lastMessage?.__meta?.timestamp === 'number' ? lastMessage.__meta.timestamp : 0);
  return {
    id: session.id,
    agent: session.agent || 'main',
    aliases: Array.isArray(session.aliases) ? [...session.aliases] : [],
    busy: !!session.busy,
    busyStartedAt: typeof session.busyStartedAt === 'number' ? session.busyStartedAt : null,
    queueLength: getEffectiveSessionQueueLength(session),
    runtimeState: sessionManager.buildSessionRuntimeState(session),
    displayName: session.displayName || null,
    archived: !!session.archived,
    currentNode: session.currentNode || 'master',
    cwd: session.cwd || null,
    model: session.model || null,
    effort: session.effort || null,
    childModelDefault: session.childModelDefault || null,
    childEffortDefault: session.childEffortDefault || null,
    compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
    verbose: !!session.verbose,
    isolated: sessionManager.isSessionEffectivelyIsolated(session),
    parentSessionId: session.parentSessionId || null,
    pinned: !!session.pinned,
    sidebarOrder: typeof session.sidebarOrder === 'number' && Number.isFinite(session.sidebarOrder)
      ? session.sidebarOrder
      : null,
    messageCount,
    historyVersion: session.historyVersion || 0,
    lastMessageTime,
    tokenUsage: {
      cachedTokens: session.stats?.totalCachedTokens || 0,
      inputTokens: session.stats?.totalInputTokens || 0,
      outputTokens: session.stats?.totalOutputTokens || 0,
      lastUsage: session.stats?.lastUsage || null,
    },
  };
}

export function overlaySessionWorkerProjection(
  session: SessionRuntimeSessionDto,
  projection: SessionWorkerProjection | undefined,
): SessionRuntimeSessionDto {
  if (!projection) return session;
  return {
    ...session,
    busy: projection.busy,
    busyStartedAt: projection.busyStartedAt,
    queueLength: projection.queueLength,
    runtimeState: structuredClone(projection.runtimeState),
    messageCount: projection.messageCount,
    historyVersion: projection.historyVersion,
    lastMessageTime: projection.lastMessageTime,
    currentNode: projection.currentNode,
    cwd: projection.cwd,
    model: projection.model,
    effort: projection.effort,
    childModelDefault: projection.childModelDefault,
    childEffortDefault: projection.childEffortDefault,
    compactThresholdTokens: projection.compactThresholdTokens,
    verbose: projection.verbose ?? session.verbose,
    tokenUsage: {
      cachedTokens: projection.stats.totalCachedTokens,
      inputTokens: projection.stats.totalInputTokens,
      outputTokens: projection.stats.totalOutputTokens,
      lastUsage: projection.stats.lastUsage,
    },
  };
}

export type SessionRuntimeWorkerProjectionOptions = {
  store: SessionWorkerStore;
  registry: SessionWorkerProjectionRegistry;
  ingress?: SessionWorkerIngressCoordinator;
  supervisor?: SessionWorkerSupervisor;
};

function isDefinitelyCleanInactiveWorkerStop(ownership: ReturnType<SessionWorkerStore['findOwnership']>): boolean {
  if (!ownership || ownership.state !== 'inactive') return false;
  const reason = ownership.lastExitReason;
  if (!reason) return true;
  // Candidate-only exits never activated or touched Session authority.
  if (reason === 'startup-abandoned-inert-candidate'
    || reason === 'post-fork-startup-failure'
    || reason === 'shutdown-provisional-child'
    || reason.startsWith('spawn-failed:')) return true;
  // Only a genuine zero-code child exit proves graceful Worker completion.
  // Intentional shutdown can escalate to SIGTERM/SIGKILL; those exits pass
  // through handback but can still leave authority busy and need recovery.
  return reason === 'stopped:0';
}

function requireSession(sessionId: string): Promise<Session> {
  return sessionManager.getExistingSession(sessionId).then((session) => {
    if (!session) {
      throw new RpcError('SESSION_NOT_FOUND', `Session \`${sessionId}\` not found.`);
    }
    return session;
  });
}

export function createSessionRuntimeServiceHandler(options?: { worker?: SessionRuntimeWorkerProjectionOptions }): RpcServiceHandler<typeof sessionRuntimeServiceDescriptor> {
  let eventContext: SessionRuntimeEventContext | undefined;
  let unsubscribeWorkerProjections: (() => void) | undefined;
  let unsubscribeWorkerIngress: (() => void) | undefined;
  const workerListSignatures = new Map<string, string>();
  const volatileLocalIds = new Set<string>();
  let volatileSequence = 1;
  type WorkerSelection =
    | { canonicalId: string; kind: 'local' }
    | { canonicalId: string; kind: 'unavailable' }
    | { canonicalId: string; kind: 'worker'; entry: SessionWorkerProjectionEntry };
  const workerSelection = (requestedId: string): WorkerSelection => {
    const canonicalId = sessionManager.resolveLoadedSessionId(requestedId);
    const ownership = options?.worker?.store.findOwnership(canonicalId);
    if (!ownership || ownership.state === 'inactive') return { canonicalId, kind: 'local' };
    const entry = options?.worker?.registry.get(canonicalId);
    return entry?.projection && !entry.stale && ownership.generation === entry.generation && ownership.incarnationId === entry.incarnationId
      ? { canonicalId, kind: 'worker', entry }
      : { canonicalId, kind: 'unavailable' };
  };
  const projectedDto = (session: Session, selection = workerSelection(session.id)): SessionRuntimeSessionDto => overlaySessionWorkerProjection(
    buildSessionRuntimeSessionDto(session), selection.kind === 'worker' ? selection.entry?.projection : undefined,
  );
  const withPendingWorkerIngress = (session: SessionRuntimeSessionDto, selection = workerSelection(session.id)): SessionRuntimeSessionDto => {
    if (selection.kind !== 'worker') return session;
    const pending = options?.worker?.store.countMailboxIntentsAfter(session.id, selection.entry.projection!.lastAppliedMailboxId) || 0;
    if (pending === 0) return session;
    const queueLength = session.queueLength + pending;
    return { ...session, queueLength, runtimeState: { ...session.runtimeState, queueLength } };
  };
  const pendingWorkerQueue = (sessionId: string, afterId: number): QueueItem[] => options!.worker!.store
    // The detached JSON snapshot owns `afterId`. Include every later durable
    // row even if the live Worker acknowledged it between the file read and
    // this query; otherwise that concurrent apply window would hide the row
    // from both sides of the composed history response.
    .listMailboxIntentsAfter(sessionId, afterId, 4096)
    .flatMap(intent => intent.kind === 'enqueue' && isQueueItem(intent.payload)
      ? [structuredClone(intent.payload)] : []);
  const ensureWorkerSelection = async (requestedId: string): Promise<Extract<WorkerSelection, { kind: 'worker' }>> => {
    const canonicalId = sessionManager.resolveLoadedSessionId(requestedId);
    if (!sessionManager.getAllSessions().has(canonicalId)) {
      throw new RpcError('SESSION_NOT_FOUND', `Session \`${canonicalId}\` not found.`);
    }
    if (!options?.worker?.ingress) {
      throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker operation is unavailable.', true);
    }
    await options.worker.ingress.ensureWorkerOwner(canonicalId);
    const selection = workerSelection(canonicalId);
    if (selection.kind !== 'worker') {
      throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Committed state for session \`${canonicalId}\` is unavailable.`, true);
    }
    return selection;
  };
  const listSignature = (session: SessionRuntimeSessionDto) => JSON.stringify({
    busy: session.busy, busyStartedAt: session.busyStartedAt, queueLength: session.queueLength,
    runtimeState: session.runtimeState, messageCount: session.messageCount, historyVersion: session.historyVersion, lastMessageTime: session.lastMessageTime,
    currentNode: session.currentNode, cwd: session.cwd, model: session.model,
    effort: session.effort, childModelDefault: session.childModelDefault,
    childEffortDefault: session.childEffortDefault, compactThresholdTokens: session.compactThresholdTokens,
    tokenUsage: session.tokenUsage, verbose: session.verbose,
  });

  const emitState = (sessionId: string) => {
    const session = sessionManager.getAllSessions().get(sessionId);
    const selection = session ? workerSelection(sessionId) : undefined;
    eventContext?.emit('stateChanged', {
      sessionId,
      session: session ? withPendingWorkerIngress(projectedDto(session, selection), selection) : null,
    });
  };

  const installEventCallbacks = (context: SessionRuntimeEventContext) => {
    eventContext = context;
    sessionManager.setOnHistoryUpdated((sessionId, message) => {
      eventContext?.emit('history', { sessionId, message });
    });
    sessionManager.setOnSessionEventUpdated((sessionId, event) => {
      eventContext?.emit('stream', { sessionId, event });
    });
    sessionManager.setOnSessionListUpdated(() => {
      volatileSequence += 1;
      eventContext?.emit('listChanged', {});
    });
    for (const session of sessionManager.getAllSessions().values()) {
      if (sessionManager.buildSessionRuntimeState(session).state !== 'idle' || getEffectiveSessionQueueLength(session) > 0) volatileLocalIds.add(session.id);
    }
    sessionManager.setOnSessionStateUpdated((sessionId) => {
      const session = sessionManager.getAllSessions().get(sessionId);
      if (session && (sessionManager.buildSessionRuntimeState(session).state !== 'idle' || getEffectiveSessionQueueLength(session) > 0)) volatileLocalIds.add(sessionId);
      else volatileLocalIds.delete(sessionId);
      volatileSequence += 1; emitState(sessionId);
    });
    unsubscribeWorkerProjections = options?.worker?.registry.subscribe((entry) => {
      const session = sessionManager.getAllSessions().get(entry.sessionId);
      if (!session) { workerListSignatures.delete(entry.sessionId); return; }
      const fallbackSignature = listSignature(buildSessionRuntimeSessionDto(session));
      if (entry.stale) {
        const previousSignature = workerListSignatures.get(entry.sessionId) || fallbackSignature;
        workerListSignatures.set(entry.sessionId, fallbackSignature);
        if (previousSignature !== fallbackSignature) {
          volatileSequence += 1; emitState(entry.sessionId); eventContext?.emit('listChanged', {});
        }
        return;
      }
      const selection = workerSelection(entry.sessionId);
      if (selection.kind !== 'worker' || selection.entry?.incarnationId !== entry.incarnationId) return;
      const current = withPendingWorkerIngress(projectedDto(session, selection), selection);
      eventContext?.emit('stateChanged', { sessionId: session.id, session: current });
      const currentSignature = listSignature(current);
      const previousSignature = workerListSignatures.get(session.id) || fallbackSignature;
      workerListSignatures.set(session.id, currentSignature);
      if (previousSignature !== currentSignature) {
        volatileSequence += 1; eventContext?.emit('listChanged', {});
      }
    });
    unsubscribeWorkerIngress = typeof options?.worker?.ingress?.subscribeDurableIntentAccepted === 'function'
      ? options.worker.ingress.subscribeDurableIntentAccepted((sessionId) => {
        const session = sessionManager.getAllSessions().get(sessionId);
        const selection = workerSelection(sessionId);
        if (!session || selection.kind !== 'worker') return;
        const current = withPendingWorkerIngress(projectedDto(session, selection), selection);
        eventContext?.emit('stateChanged', { sessionId, session: current });
        volatileSequence += 1;
        eventContext?.emit('listChanged', {});
      })
      : undefined;
  };

  const uninstallEventCallbacks = () => {
    eventContext = undefined;
    sessionManager.setOnHistoryUpdated(() => {});
    sessionManager.setOnSessionEventUpdated(() => {});
    sessionManager.setOnSessionListUpdated(() => {});
    sessionManager.setOnSessionStateUpdated(() => {});
    unsubscribeWorkerProjections?.(); unsubscribeWorkerProjections = undefined;
    unsubscribeWorkerIngress?.(); unsubscribeWorkerIngress = undefined;
    workerListSignatures.clear();
    volatileLocalIds.clear();
  };

  return {
    async getSession(input) {
      const requestedId = normalizeSessionId(input.sessionId);
      const selection = workerSelection(requestedId);
      if (selection.kind === 'unavailable') {
        throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Committed state for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      const session = options?.worker
        ? sessionManager.getAllSessions().get(selection.canonicalId) || null
        : selection.kind === 'worker'
          ? sessionManager.getAllSessions().get(selection.canonicalId) || null
          : await sessionManager.getExistingSession(selection.canonicalId);
      if (selection.kind === 'worker' && !session) {
        throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Committed state for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      return { session: session ? withPendingWorkerIngress(projectedDto(session, selection), selection) : null };
    },
    listSessions(input) {
      const limit = input.limit === undefined ? sessionManager.getAllSessions().size : Math.max(0, Math.min(1000, Math.floor(input.limit)));
      const offset = Math.max(0, Math.floor(input.offset || 0));
      if (!options?.worker) {
        const page = sessionManager.listSessionCatalogPage(limit, offset);
        return {
          sessions: page.sessions.map(session => projectedDto(session)),
          total: page.total,
        };
      }
      const activeProjectionCount = options?.worker?.registry.list().length || 0;
      const candidatePage = sessionManager.listSessionCatalogPage(limit + offset + activeProjectionCount, 0);
      const candidates = new Map(candidatePage.sessions.map(session => [session.id, withPendingWorkerIngress(projectedDto(session))]));
      for (const entry of options?.worker?.registry.list() || []) {
        const session = sessionManager.getAllSessions().get(entry.sessionId);
        if (session) candidates.set(session.id, withPendingWorkerIngress(projectedDto(session)));
      }
      return {
        sessions: [...candidates.values()]
          .sort((a, b) => b.lastMessageTime - a.lastMessageTime || a.id.localeCompare(b.id))
          .slice(offset, offset + limit),
        total: candidatePage.total,
      };
    },
    getSessionListProjections(input) {
      if (!Array.isArray(input.sessionIds) || input.sessionIds.length > 200
        || input.sessionIds.some(id => typeof id !== 'string' || !id || id.length > 512)
        || (input.includeVolatile !== undefined && typeof input.includeVolatile !== 'boolean')
        || (input.currentOwnersOnly !== undefined && typeof input.currentOwnersOnly !== 'boolean')) {
        throw new RpcError('SESSION_LIST_PROJECTION_INVALID', 'sessionIds must contain at most 200 bounded Session IDs.');
      }
      const requested = new Set(input.sessionIds);
      const ownerships = new Map((options?.worker?.store.listFencedOwnerships() || []).map(item => [item.sessionId, item]));
      const entries = new Map((options?.worker?.registry.list() || []).map(item => [item.sessionId, item]));
      if (input.includeVolatile) {
        for (const entry of entries.values()) {
          const ownership = ownerships.get(entry.sessionId);
          if (entry.projection && !entry.stale && ownership && ownership.generation === entry.generation
            && ownership.incarnationId === entry.incarnationId) requested.add(entry.sessionId);
        }
        for (const sessionId of volatileLocalIds) if (!ownerships.has(sessionId)) requested.add(sessionId);
        // Normal startup installs event callbacks and keeps volatileLocalIds
        // incrementally. Direct low-level callers that have not started events
        // retain correctness through this compatibility-only in-memory scan.
        if (!eventContext) {
          for (const session of sessionManager.getAllSessions().values()) {
            if (!ownerships.has(session.id)
              && (sessionManager.buildSessionRuntimeState(session).state !== 'idle' || getEffectiveSessionQueueLength(session) > 0)) requested.add(session.id);
          }
        }
      }
      const sessions: SessionRuntimeSessionDto[] = [];
      for (const id of requested) {
        const session = sessionManager.getAllSessions().get(id); if (!session) continue;
        const ownership = ownerships.get(id); const entry = entries.get(id);
        const projection = ownership && entry?.projection && !entry.stale && ownership.generation === entry.generation
          && ownership.incarnationId === entry.incarnationId ? entry.projection : undefined;
        if (input.currentOwnersOnly && ownership && !projection) continue;
        const projected = overlaySessionWorkerProjection(buildSessionRuntimeSessionDto(session), projection);
        sessions.push(withPendingWorkerIngress(projected));
      }
      return { sessions, revision: `${sessionCatalogStore.getPresentationRevision()}:${volatileSequence}` };
    },
    async getHistory(input) {
      const requestedId = normalizeSessionId(input.sessionId);
      const selection = options?.worker ? await ensureWorkerSelection(requestedId) : workerSelection(requestedId);
      if (selection.kind === 'unavailable') {
        throw new RpcError('SESSION_WORKER_HISTORY_UNAVAILABLE', `Authoritative history for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      const session = selection.kind === 'worker'
        ? sessionManager.getAllSessions().get(selection.canonicalId) || null
        : await sessionManager.getExistingSession(selection.canonicalId);
      if (selection.kind === 'worker' && !session) {
        throw new RpcError('SESSION_WORKER_HISTORY_UNAVAILABLE', `Authoritative history for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      if (!session) return null;
      if (selection.kind === 'worker') {
        const detached = await readDetachedWorkerSession(selection.canonicalId, session);
        // Compose from the authoritative JSON cursor, not the SQLite ack
        // cursor: JSON-ahead/ack-late rows may still be marked pending in
        // SQLite but are already reflected in detached.queue.
        const pending = pendingWorkerQueue(selection.canonicalId, detached.lastAppliedMailboxId || 0);
        const dto = withPendingWorkerIngress(projectedDto(session, selection), selection);
        return {
          session: dto,
          messages: detached.history,
          queue: [...(detached.queue || []), ...pending],
          persistentMemorySnapshot: detached.persistentMemorySnapshot || '',
        };
      }
      const history = session.history;
      const historySnapshot = history.slice();
      const canonical = await externalizeMessages(historySnapshot);
      if (canonical.changed) {
        if (session.history !== history
          || history.length !== historySnapshot.length
          || !historySnapshot.every((message, index) => history[index] === message)) {
          throw new RpcError(
            'SESSION_HISTORY_CHANGED',
            `Session \`${session.id}\` history changed while the snapshot was being prepared.`,
            true,
          );
        }
        history.splice(0, historySnapshot.length, ...canonical.messages);
        await sessionManager.saveSession(session.id);
      }
      return {
        session: buildSessionRuntimeSessionDto(session),
        messages: session.history,
        queue: session.queue || [],
        persistentMemorySnapshot: session.persistentMemorySnapshot || '',
      };
    },
    async enqueue(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (!isQueueItem(input.item)) {
        throw new RpcError('SESSION_RUNTIME_INVALID_QUEUE_ITEM', 'item must be a current non-empty QueueItem DTO.');
      }
      await sessionManager.enqueueSessionItem(sessionId, input.item);
      return { accepted: true };
    },
    async submitAndRun(input) {
      const normalized = normalizeSessionWorkerIngressRequest(input);
      if (!options?.worker?.ingress) {
        throw new RpcError('SESSION_WORKER_INGRESS_UNAVAILABLE', 'Session-worker ingress is unavailable.', true);
      }
      sessionManager.assertSessionDestructiveMutationAllowed([normalized.sessionId], 'accept queued work');
      return options.worker.ingress.submitEnsuringWorker(normalized.sessionId, normalized.item);
    },
    async requestCompaction(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('SESSION_RUNTIME_INVALID_COMPACTION', 'Compaction request must be an object.');
      const unknown = Object.keys(input).find(key => !['sessionId', 'keepPercent', 'toolNoise'].includes(key));
      if (unknown || (input.keepPercent !== undefined && (!Number.isFinite(input.keepPercent) || input.keepPercent! <= 0 || input.keepPercent! > 1))
        || (input.toolNoise !== undefined && typeof input.toolNoise !== 'boolean')) throw new RpcError('SESSION_RUNTIME_INVALID_COMPACTION', 'Compaction request is invalid.');
      const requestedId = normalizeSessionId(input.sessionId); const selection = options?.worker
        ? await ensureWorkerSelection(requestedId)
        : workerSelection(requestedId);
      if (selection.kind === 'unavailable') throw new RpcError('SESSION_WORKER_COMPACTION_UNAVAILABLE', 'Committed Worker state is unavailable.', true);
      if (selection.kind === 'worker') {
        sessionManager.assertSessionDestructiveMutationAllowed([selection.canonicalId], 'start compaction work');
        if (!options?.worker?.ingress) throw new RpcError('SESSION_WORKER_COMPACTION_UNAVAILABLE', 'Session-worker compaction is unavailable.', true);
        if (input.toolNoise) {
          const result = await options.worker.ingress.compactToolMessages(selection.canonicalId, input.keepPercent);
          if (!('result' in result)) return { kind: 'empty' };
          return { kind: 'tool-noise', result: result.result };
        }
        const result = await options.worker.ingress.compactAwaited(selection.canonicalId, { keepPercent: input.keepPercent });
        return { kind: 'worker', completed: true, compacted: result.compacted, messageCount: result.messageCount };
      }
      const localSession = await requireSession(selection.canonicalId);
      if (localSession.history.length === 0) return { kind: 'empty' };
      if (input.toolNoise) {
        return { kind: 'tool-noise', result: await sessionManager.compactSessionToolMessages(selection.canonicalId, input.keepPercent) };
      }
      return { kind: 'local', ...await sessionManager.requestSessionCompaction(selection.canonicalId, { keepPercent: input.keepPercent }) };
    },
    async cancelCompaction(input) {
      const requestedId = normalizeSessionId(input.sessionId);
      const selection = workerSelection(requestedId);
      if (options?.worker && selection.kind === 'local') return { outcome: 'none' };
      if (selection.kind === 'unavailable') throw new RpcError('SESSION_WORKER_COMPACTION_UNAVAILABLE', 'Committed Worker state is unavailable.', true);
      if (selection.kind === 'worker') {
        if (!options?.worker?.ingress) throw new RpcError('SESSION_WORKER_COMPACTION_UNAVAILABLE', 'Session-worker compaction cancellation is unavailable.', true);
        return options.worker.ingress.cancelCompaction(selection.canonicalId);
      }
      return sessionManager.cancelSessionCompaction(selection.canonicalId);
    },
    async runBtw(input) {
      const requestedId = normalizeSessionId(input.sessionId);
      if (typeof input.message !== 'string' || !input.message.trim()
        || Buffer.byteLength(input.message, 'utf8') > 1024 * 1024) {
        throw new RpcError('SESSION_RUNTIME_INVALID_BTW', 'BTW message must be a non-empty bounded string.');
      }
      if (options?.worker) {
        const selection = await ensureWorkerSelection(requestedId);
        if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_BTW_UNAVAILABLE', 'Session-worker BTW is unavailable.', true);
        const result = await options.worker.ingress.runBtw(selection.canonicalId, input.message);
        return { text: result.text, toolDenied: result.toolDenied };
      }
      return runBtwRequest(requestedId, input.message);
    },
    async queueEvent(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (typeof input.text !== 'string' || !input.text) {
        throw new RpcError('SESSION_RUNTIME_INVALID_EVENT', 'text must be a non-empty string.');
      }
      const type = input.type || 'background';
      if (!['background', 'trigger', 'onboot'].includes(type)) {
        throw new RpcError('SESSION_RUNTIME_INVALID_EVENT', 'type must be background, trigger, or onboot.');
      }
      await sessionManager.queueSessionEvent(sessionId, input.text, type);
      return { accepted: true };
    },
    async updateSettings(input) {
      const settingsSessionId = normalizeSessionId(input.sessionId);
      if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
        throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', 'patch must be an object.');
      }
      const supportedKeys = new Set(['cwd', 'model', 'effort', 'childModelDefault', 'childEffortDefault', 'currentNode', 'displayName', 'compactThresholdTokens', 'verbose']);
      const suppliedKeys = Object.keys(input.patch);
      const unknownKey = suppliedKeys.find(key => !supportedKeys.has(key));
      if (unknownKey) {
        throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', `Unsupported session setting: ${unknownKey}.`);
      }
      const stringKeys = ['cwd', 'model', 'childModelDefault', 'currentNode', 'displayName'] as const;
      const normalizedStrings = new Map<typeof stringKeys[number], string | null>();
      for (const key of stringKeys) {
        const normalized = normalizeNullableSetting(input.patch, key);
        if (normalized !== undefined) normalizedStrings.set(key, normalized);
      }
      const normalizedEfforts = new Map<'effort' | 'childEffortDefault', ModelEffort | null>();
      for (const key of ['effort', 'childEffortDefault'] as const) {
        const normalized = normalizeNullableEffortSetting(input.patch, key);
        if (normalized !== undefined) normalizedEfforts.set(key, normalized);
      }
      let normalizedThreshold: number | null | undefined;
      if (Object.prototype.hasOwnProperty.call(input.patch, 'compactThresholdTokens')) {
        const threshold = input.patch.compactThresholdTokens;
        if (threshold !== null && threshold !== undefined
          && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0)) {
          throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', 'compactThresholdTokens must be a positive number or null.');
        }
        normalizedThreshold = threshold === null || threshold === undefined ? null : Math.floor(threshold);
      }
      let normalizedVerbose: boolean | undefined;
      if (Object.prototype.hasOwnProperty.call(input.patch, 'verbose')) {
        if (typeof input.patch.verbose !== 'boolean') {
          throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', 'verbose must be boolean.');
        }
        normalizedVerbose = input.patch.verbose;
      }
      if (options?.worker) {
        const selection = workerSelection(settingsSessionId);
        if (suppliedKeys.length === 0) {
          const stub = sessionManager.getAllSessions().get(selection.canonicalId);
          if (!stub) throw new RpcError('SESSION_NOT_FOUND', `Session \`${selection.canonicalId}\` not found.`);
          const current = settingsFromSession(stub);
          return { changed: [], previous: current, current, session: projectedDto(stub, workerSelection(stub.id)) };
        }
        const displayNameOnly = suppliedKeys.length > 0 && suppliedKeys.every(key => key === 'displayName')
          && normalizedStrings.has('displayName');
        const semanticKeys = suppliedKeys.filter(key => key !== 'displayName');
        if (displayNameOnly) {
          // displayName is Main-owned presentation metadata. It never enters
          // the worker authority, even when the worker is active or absent.
          const stub = sessionManager.getAllSessions().get(selection.canonicalId);
          if (!stub) throw new RpcError('SESSION_NOT_FOUND', `Session \`${selection.canonicalId}\` not found.`);
          const previous = settingsFromSession(stub);
          const normalized = normalizedStrings.get('displayName')!;
          const changed: Array<keyof SessionRuntimeSettingsPatchDto> = previous.displayName !== normalized ? ['displayName'] : [];
          if (changed.length > 0) {
            await sessionManager.setSessionDisplayName(stub.id, normalized ?? undefined);
          }
          return { changed, previous, current: settingsFromSession(stub), session: projectedDto(stub, workerSelection(stub.id)) };
        }
        if (semanticKeys.length > 0 && suppliedKeys.includes('displayName')) {
          throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', 'displayName cannot be changed in the same operation as worker-owned settings.');
        }
        if (semanticKeys.length > 0) {
          const workerSelectionResult = await ensureWorkerSelection(settingsSessionId);
          if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker settings are unavailable.', true);
          const patch: any = {};
          for (const [key, normalized] of normalizedStrings) {
            if (key !== 'displayName') patch[key] = normalized;
          }
          for (const [key, normalized] of normalizedEfforts) patch[key] = normalized;
          if (normalizedThreshold !== undefined) patch.compactThresholdTokens = normalizedThreshold;
          if (normalizedVerbose !== undefined) patch.verbose = normalizedVerbose;
          const workerResult = await options.worker.ingress.updateSettings(workerSelectionResult.canonicalId, patch);
          const stub = sessionManager.getAllSessions().get(workerSelectionResult.canonicalId);
          if (!stub) throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Session \`${workerSelectionResult.canonicalId}\` is unavailable.`, true);
          const previous = { ...settingsFromSession(stub), ...workerResult.previous };
          const current = { ...settingsFromSession(stub), ...workerResult.current };
          return {
            changed: workerResult.changed as Array<keyof SessionRuntimeSettingsPatchDto>,
            previous,
            current,
            session: projectedDto(stub, workerSelectionResult),
          };
        }
      }
      const session = await requireSession(settingsSessionId);
      const previous = settingsFromSession(session);
      const changed: Array<keyof SessionRuntimeSettingsPatchDto> = [];
      const hasModelEffortMutation = ['model', 'effort', 'childModelDefault', 'childEffortDefault']
        .some(key => Object.prototype.hasOwnProperty.call(input.patch, key));
      if (hasModelEffortMutation) {
        let normalized;
        try {
          normalized = normalizeProspectiveSessionModelEffortSettings(session, {
            ...(normalizedStrings.has('model') ? { model: normalizedStrings.get('model')! } : {}),
            ...(normalizedEfforts.has('effort') ? { effort: normalizedEfforts.get('effort')! } : {}),
            ...(normalizedStrings.has('childModelDefault') ? { childModelDefault: normalizedStrings.get('childModelDefault')! } : {}),
            ...(normalizedEfforts.has('childEffortDefault') ? { childEffortDefault: normalizedEfforts.get('childEffortDefault')! } : {}),
          });
        } catch (error: any) {
          throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', error?.message || String(error));
        }
        changed.push(...applyNormalizedSessionModelEffortSettings(session, normalized));
      }
      for (const [key, normalized] of normalizedStrings) {
        if (key === 'model' || key === 'childModelDefault') continue;
        const prior = settingsFromSession(session)[key];
        if (prior !== normalized) changed.push(key);
        if (normalized === null) delete session[key];
        else session[key] = normalized;
      }
      if (normalizedThreshold !== undefined) {
        if (settingsFromSession(session).compactThresholdTokens !== normalizedThreshold) changed.push('compactThresholdTokens');
        if (normalizedThreshold === null) delete session.compactThresholdTokens;
        else session.compactThresholdTokens = normalizedThreshold;
      }
      if (normalizedVerbose !== undefined) {
        if (!!session.verbose !== normalizedVerbose) changed.push('verbose');
        session.verbose = normalizedVerbose;
      }
      const settingOrder: Array<keyof SessionRuntimeSettingsPatchDto> = [
        'cwd', 'model', 'effort', 'childModelDefault', 'childEffortDefault',
        'currentNode', 'displayName', 'compactThresholdTokens', 'verbose',
      ];
      changed.sort((left, right) => settingOrder.indexOf(left) - settingOrder.indexOf(right));
      if (changed.length > 0) {
        await sessionManager.saveSession(session.id);
      }
      return {
        changed,
        previous,
        current: settingsFromSession(session),
        session: buildSessionRuntimeSessionDto(session),
      };
    },
    async deleteMessages(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (!Number.isSafeInteger(input.num) || input.num === 0) {
        throw new RpcError('SESSION_RUNTIME_INVALID_HISTORY', 'num must be a non-zero safe integer.');
      }
      if (options?.worker) {
        const selection = await ensureWorkerSelection(sessionId);
        if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker history mutation is unavailable.', true);
        const result = await options.worker.ingress.deleteMessages(selection.canonicalId, input.num);
        const stub = sessionManager.getAllSessions().get(selection.canonicalId);
        if (!stub) throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Session \`${selection.canonicalId}\` is unavailable.`, true);
        return { deleted: result.deleted || 0, remaining: result.remaining || 0, session: projectedDto(stub, workerSelection(selection.canonicalId)) };
      }
      const result = await sessionManager.deleteMessages(sessionId, input.num);
      const session = await requireSession(sessionId);
      return { ...result, session: buildSessionRuntimeSessionDto(session) };
    },
    async clearHistory(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (options?.worker) {
        const selection = await ensureWorkerSelection(sessionId);
        const projection = selection.entry?.projection;
        if (projection?.busy) {
          let abortedInFlight = false;
          if (options.worker.supervisor) {
            const ownership = options.worker.store.findOwnership(selection.canonicalId);
            if (ownership && options.worker.supervisor.getStatus(selection.canonicalId)?.ready) {
              abortedInFlight = (await options.worker.supervisor.interruptActivated(selection.canonicalId, ownership)).abortedInFlight;
            }
          }
          const stub = sessionManager.getAllSessions().get(selection.canonicalId);
          if (!stub) throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Session \`${selection.canonicalId}\` is unavailable.`, true);
          return {
            cleared: false, requiresRetry: true, droppedQueueItems: 0,
            abortedInFlight, session: projectedDto(stub, workerSelection(selection.canonicalId)),
          };
        }
        if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker history mutation is unavailable.', true);
        await options.worker.ingress.clearHistory(selection.canonicalId);
        const stub = sessionManager.getAllSessions().get(selection.canonicalId);
        if (!stub) throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Session \`${selection.canonicalId}\` is unavailable.`, true);
        return {
          cleared: true, requiresRetry: false, droppedQueueItems: 0, abortedInFlight: false,
          session: projectedDto(stub, workerSelection(selection.canonicalId)),
        };
      }
      const prepared = await sessionManager.prepareSessionForDestructiveAction(sessionId);
      if (prepared.requiresRetry) {
        return {
          cleared: false, requiresRetry: true, droppedQueueItems: prepared.droppedQueueItems,
          abortedInFlight: prepared.abortedInFlight, session: buildSessionRuntimeSessionDto(prepared.session),
        };
      }
      await sessionManager.clearSession(sessionId);
      const session = await requireSession(sessionId);
      return {
        cleared: true, requiresRetry: false, droppedQueueItems: prepared.droppedQueueItems,
        abortedInFlight: prepared.abortedInFlight, session: buildSessionRuntimeSessionDto(session),
      };
    },
    async forceIndex(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (options?.worker) {
        const selection = await ensureWorkerSelection(sessionId);
        if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker indexing is unavailable.', true);
        const result = await options.worker.ingress.forceIndex(selection.canonicalId);
        const stub = sessionManager.getAllSessions().get(selection.canonicalId);
        if (!stub) throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Session \`${selection.canonicalId}\` is unavailable.`, true);
        return { latestSeq: result.latestSeq || 0, session: projectedDto(stub, workerSelection(selection.canonicalId)) };
      }
      await sessionManager.forceIndexSession(sessionId);
      const session = await requireSession(sessionId);
      return { latestSeq: Math.max(0, (session.nextMessageSeq || 1) - 1), session: buildSessionRuntimeSessionDto(session) };
    },
    async refreshSnapshot(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (options?.worker) {
        const selection = await ensureWorkerSelection(sessionId);
        if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker snapshot refresh is unavailable.', true);
        const result = await options.worker.ingress.refreshSnapshot(selection.canonicalId);
        const stub = sessionManager.getAllSessions().get(selection.canonicalId);
        if (!stub) throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Session \`${selection.canonicalId}\` is unavailable.`, true);
        return { agentName: result.agentName || stub.agent || 'main', session: projectedDto(stub, workerSelection(selection.canonicalId)) };
      }
      const result = await sessionManager.refreshSessionSnapshot(sessionId);
      const session = await requireSession(sessionId);
      return { ...result, session: buildSessionRuntimeSessionDto(session) };
    },
    async notifyManualForkCreated(input) {
      const parentSessionId = normalizeSessionId(input.parentSessionId);
      const childSessionId = normalizeSessionId(input.childSessionId);
      if (input.initialMessage !== undefined && typeof input.initialMessage !== 'string') {
        throw new RpcError('SESSION_RUNTIME_INVALID_FORK', 'initialMessage must be a string when supplied.');
      }
      if (options?.worker) {
        sessionManager.assertSessionDestructiveMutationAllowed([parentSessionId], 'receive a new fork session');
        // The parent event is a semantic history mutation, so it follows the
        // exact parent owner rather than hydrating a Main catalog stub.
        const selection = await ensureWorkerSelection(parentSessionId);
        if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker fork notification is unavailable.', true);
        // Admission is classified from the current committed projection. A
        // busy owner receives the existing background QueueItem so the active
        // canonical runner can ingest it at its next persisted safe point. An
        // idle owner keeps the existing append-only notification semantics.
        if (selection.entry.projection.busy) {
          const notification = sessionManager.buildManualForkNotificationMessage(
            selection.canonicalId,
            childSessionId,
            input.initialMessage,
          );
          await options.worker.ingress.enqueueEnsuringWorker(selection.canonicalId, {
            type: 'background',
            message: notification,
          });
          return { result: 'queued' };
        }
        const result = await options.worker.ingress.notifyManualForkCreated(selection.canonicalId, childSessionId, input.initialMessage);
        return { result: result.result };
      }
      return { result: await sessionManager.notifyManualForkCreated(parentSessionId, childSessionId, input.initialMessage) };
    },
    async control(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      if (options?.worker) {
        if (input.action === 'retry') {
          sessionManager.assertSessionDestructiveMutationAllowed([sessionId], 'start retry work');
          if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker retry is unavailable.', true);
          const source = input.source === undefined ? undefined : normalizeSessionTurnDeliverySource(input.source);
          await options.worker.ingress.retryEnsuringWorker(sessionId, source);
          return { action: 'retry' };
        }
        if (input.source !== undefined) throw new RpcError('SESSION_RUNTIME_INVALID_CONTROL', 'source is supported only for retry.');
        if (input.action === 'dequeue') {
          sessionManager.assertSessionDestructiveMutationAllowed([sessionId], 'start queued work');
          if (!options.worker.ingress) throw new RpcError('SESSION_WORKER_OPERATION_UNAVAILABLE', 'Session-worker dequeue is unavailable.', true);
          const selection = await ensureWorkerSelection(sessionId);
          const dequeued = await options.worker.ingress.dequeueEnsuringWorker(selection.canonicalId);
          return { action: 'dequeue', ...dequeued };
        }
        const selection = workerSelection(sessionId);
        if (input.action === 'stop' && selection.kind === 'local') {
          const inactiveOwnership = options.worker.store.findOwnership(selection.canonicalId);
          if (inactiveOwnership?.state === 'inactive' && !isDefinitelyCleanInactiveWorkerStop(inactiveOwnership)) {
            throw new RpcError(
              'SESSION_WORKER_STOP_OUTCOME_UNKNOWN',
              'Stop may not have been applied because prior Session worker shutdown was not confirmed clean. Inspect session history/state before retrying.',
              true,
            );
          }
          const local = sessionManager.getAllSessions().get(selection.canonicalId);
          if (local && !local.busy) return { action: 'stop', abortedInFlight: false };
        }
        if (selection.kind !== 'local') {
          if (input.action === 'stop' && options.worker.supervisor) {
            // Closed stop for a worker-fenced session: the interrupt aborts the
            // active provider request immediately, captures the exact durable
            // mailbox boundary while ordinary ingress admission is held, and
            // returns success only after the in-flight turn's authoritative
            // passive finalization has persisted. Authority stays worker-owned.
            const ownership = options.worker.store.findOwnership(selection.canonicalId);
            const status = options.worker.supervisor.getStatus(selection.canonicalId);
            const exactReady = !!ownership && ownership.state === 'ready' && !!ownership.incarnationId
              && !!status?.ready && ownership.generation === status.generation
              && ownership.incarnationId === status.incarnationId;
            if (exactReady) {
              try {
                const interrupt = options.worker.ingress
                  ? await options.worker.ingress.stopActivatedWorker(selection.canonicalId, ownership!)
                  : await options.worker.supervisor.interruptActivated(selection.canonicalId, ownership);
                return { action: 'stop', abortedInFlight: interrupt.abortedInFlight };
              } catch (error: any) {
                if (error?.code === 'SESSION_WORKER_STOP_OUTCOME_UNKNOWN') throw error;
                if (['SESSION_WORKER_INGRESS_UNAVAILABLE', 'SESSION_WORKER_UNAVAILABLE', 'SESSION_WORKER_STATE_UNAVAILABLE'].includes(error?.code)) {
                  throw new RpcError(
                    'SESSION_WORKER_STOP_OUTCOME_UNKNOWN',
                    'Stop may not have been applied because the exact Session worker became unavailable. Inspect session history/state before retrying.',
                    true,
                  );
                }
                throw error;
              }
            }
            throw new RpcError(
              'SESSION_WORKER_STOP_OUTCOME_UNKNOWN',
              'Stop may not have been applied because the exact Session worker is unavailable. Inspect session history/state before retrying.',
              true,
            );
          }
          throw new RpcError('SESSION_WORKER_CONTROL_UNSUPPORTED', 'Session-worker control is unsupported.', true);
        }
      }
      if (input.action === 'stop') {
        return { action: 'stop', ...await sessionManager.requestSessionStop(sessionId) };
      }
      if (input.action === 'dequeue') {
        return { action: 'dequeue', ...await sessionManager.requestSessionDequeue(sessionId) };
      }
      if (input.action === 'retry') {
        await sessionManager.retrySession(sessionId);
        return { action: 'retry' };
      }
      throw new RpcError('SESSION_RUNTIME_INVALID_CONTROL', 'action must be stop, dequeue, or retry.');
    },
    startEvents(_input, context) {
      installEventCallbacks(context);
      return { started: true };
    },
    stopEvents() {
      uninstallEventCallbacks();
      return { stopped: true };
    },
  };
}
