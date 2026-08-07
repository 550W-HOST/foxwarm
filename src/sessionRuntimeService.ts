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
import type { Message, QueueItem, Session, SessionStreamEvent, TokenUsage } from './types';
import { isQueueItem } from './types';
import type { SessionRuntimeState } from './sessionRuntimeState';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';
import type { SessionWorkerProjectionEntry, SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import type { SessionWorkerStore } from './sessionWorkerStore';
import type { SessionWorkerIngressCoordinator, SessionWorkerIngressResult } from './sessionWorkerIngress';
import { normalizeSessionWorkerIngressRequest } from './sessionWorkerIngress';
import { readDetachedWorkerSession } from './sessionWorkerSnapshot';

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
  childModelDefault: string | null;
  compactThresholdTokens: number | null;
  isolated: boolean;
  parentSessionId: string | null;
  pinned: boolean;
  sidebarOrder: number | null;
  messageCount: number;
  lastMessageTime: number;
  tokenUsage: SessionRuntimeTokenTotalsDto;
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
  childModelDefault?: string | null;
  currentNode?: string | null;
  displayName?: string | null;
  compactThresholdTokens?: number | null;
};

export type SessionRuntimeSettingsDto = Required<SessionRuntimeSettingsPatchDto>;

export type SessionRuntimeSettingsResultDto = {
  changed: Array<keyof SessionRuntimeSettingsPatchDto>;
  previous: SessionRuntimeSettingsDto;
  current: SessionRuntimeSettingsDto;
  session: SessionRuntimeSessionDto;
};

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

export const sessionRuntimeServiceDescriptor = defineRpcService('session-runtime', 1, {
  getSession: rpcMethod<{ sessionId: string }, { session: SessionRuntimeSessionDto | null }>(),
  listSessions: rpcMethod<Record<string, never>, { sessions: SessionRuntimeSessionDto[] }>(),
  getHistory: rpcMethod<{ sessionId: string }, SessionRuntimeHistoryDto | null>(),
  enqueue: rpcMethod<{ sessionId: string; item: QueueItem }, { accepted: true }>(),
  submitAndRun: rpcMethod<{ sessionId: string; item: QueueItem }, SessionWorkerIngressResult>(),
  requestCompaction: rpcMethod<{ sessionId: string; keepPercent?: number; toolNoise?: boolean }, SessionRuntimeCompactionResultDto>(),
  queueEvent: rpcMethod<{
    sessionId: string;
    text: string;
    type?: 'background' | 'trigger' | 'onboot';
  }, { accepted: true }>(),
  updateSettings: rpcMethod<{
    sessionId: string;
    patch: SessionRuntimeSettingsPatchDto;
  }, SessionRuntimeSettingsResultDto>(),
  control: rpcMethod<{
    sessionId: string;
    action: SessionRuntimeControlAction;
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
    childModelDefault: typeof session.childModelDefault === 'string' && session.childModelDefault.trim()
      ? session.childModelDefault.trim()
      : null,
    currentNode: typeof session.currentNode === 'string' && session.currentNode.trim() ? session.currentNode.trim() : null,
    displayName: typeof session.displayName === 'string' && session.displayName.trim() ? session.displayName.trim() : null,
    compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
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
    queueLength: session.queue?.length || 0,
    runtimeState: sessionManager.buildSessionRuntimeState(session),
    displayName: session.displayName || null,
    archived: !!session.archived,
    currentNode: session.currentNode || 'master',
    cwd: session.cwd || null,
    model: session.model || null,
    childModelDefault: session.childModelDefault || null,
    compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
    isolated: sessionManager.isSessionEffectivelyIsolated(session),
    parentSessionId: session.parentSessionId || null,
    pinned: !!session.pinned,
    sidebarOrder: typeof session.sidebarOrder === 'number' && Number.isFinite(session.sidebarOrder)
      ? session.sidebarOrder
      : null,
    messageCount,
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
    lastMessageTime: projection.lastMessageTime,
    currentNode: projection.currentNode,
    cwd: projection.cwd,
    model: projection.model,
    childModelDefault: projection.childModelDefault,
    compactThresholdTokens: projection.compactThresholdTokens,
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
};

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
  const workerListSignatures = new Map<string, string>();
  type WorkerSelection = { canonicalId: string; kind: 'local' | 'unavailable' | 'worker'; entry?: SessionWorkerProjectionEntry };
  const workerSelection = (requestedId: string): WorkerSelection => {
    const canonicalId = sessionManager.resolveLoadedSessionId(requestedId);
    const ownership = options?.worker?.store.findOwnership(canonicalId);
    if (!ownership || ownership.state === 'inactive') return { canonicalId, kind: 'local' };
    const entry = options?.worker?.registry.get(canonicalId);
    return entry?.projection && ownership.generation === entry.generation && ownership.incarnationId === entry.incarnationId
      ? { canonicalId, kind: 'worker', entry }
      : { canonicalId, kind: 'unavailable' };
  };
  const projectedDto = (session: Session, selection = workerSelection(session.id)): SessionRuntimeSessionDto => overlaySessionWorkerProjection(
    buildSessionRuntimeSessionDto(session), selection.kind === 'worker' ? selection.entry?.projection : undefined,
  );
  const listSignature = (session: SessionRuntimeSessionDto) => JSON.stringify({
    busy: session.busy, busyStartedAt: session.busyStartedAt, queueLength: session.queueLength,
    runtimeState: session.runtimeState, messageCount: session.messageCount, lastMessageTime: session.lastMessageTime,
    currentNode: session.currentNode, cwd: session.cwd, model: session.model,
    childModelDefault: session.childModelDefault, compactThresholdTokens: session.compactThresholdTokens,
    tokenUsage: session.tokenUsage,
  });

  const emitState = (sessionId: string) => {
    const session = sessionManager.getAllSessions().get(sessionId);
    eventContext?.emit('stateChanged', {
      sessionId,
      session: session ? buildSessionRuntimeSessionDto(session) : null,
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
      eventContext?.emit('listChanged', {});
    });
    sessionManager.setOnSessionStateUpdated(emitState);
    unsubscribeWorkerProjections = options?.worker?.registry.subscribe((entry) => {
      const selection = workerSelection(entry.sessionId);
      if (selection.kind !== 'worker' || selection.entry?.incarnationId !== entry.incarnationId) return;
      const session = sessionManager.getAllSessions().get(entry.sessionId);
      if (!session) return;
      const current = projectedDto(session, selection);
      eventContext?.emit('stateChanged', { sessionId: session.id, session: current });
      const currentSignature = listSignature(current);
      const previousSignature = workerListSignatures.get(session.id) || listSignature(buildSessionRuntimeSessionDto(session));
      workerListSignatures.set(session.id, currentSignature);
      if (previousSignature !== currentSignature) eventContext?.emit('listChanged', {});
    });
  };

  const uninstallEventCallbacks = () => {
    eventContext = undefined;
    sessionManager.setOnHistoryUpdated(() => {});
    sessionManager.setOnSessionEventUpdated(() => {});
    sessionManager.setOnSessionListUpdated(() => {});
    sessionManager.setOnSessionStateUpdated(() => {});
    unsubscribeWorkerProjections?.(); unsubscribeWorkerProjections = undefined;
    workerListSignatures.clear();
  };

  return {
    async getSession(input) {
      const requestedId = normalizeSessionId(input.sessionId);
      const selection = workerSelection(requestedId);
      if (selection.kind === 'unavailable') {
        throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Committed state for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      if (options?.worker && selection.kind === 'local' && !sessionManager.getAllSessions().has(selection.canonicalId)) {
        return { session: null };
      }
      const session = selection.kind === 'worker'
        ? sessionManager.getAllSessions().get(selection.canonicalId) || null
        : await sessionManager.getExistingSession(selection.canonicalId);
      if (selection.kind === 'worker' && !session) {
        throw new RpcError('SESSION_WORKER_STATE_UNAVAILABLE', `Committed state for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      return { session: session ? projectedDto(session, selection) : null };
    },
    listSessions() {
      return {
        sessions: [...sessionManager.getAllSessions().values()]
          .map(session => projectedDto(session))
          .sort((a, b) => b.lastMessageTime - a.lastMessageTime),
      };
    },
    async getHistory(input) {
      const requestedId = normalizeSessionId(input.sessionId);
      const selection = workerSelection(requestedId);
      if (selection.kind === 'unavailable') {
        throw new RpcError('SESSION_WORKER_HISTORY_UNAVAILABLE', `Authoritative history for session \`${selection.canonicalId}\` is unavailable.`, true);
      }
      if (options?.worker && selection.kind === 'local' && !sessionManager.getAllSessions().has(selection.canonicalId)) {
        return null;
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
        return {
          session: projectedDto(session, selection),
          messages: detached.history,
          queue: detached.queue || [],
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
      return options.worker.ingress.submitQueuedInput(normalized.sessionId, normalized.item);
    },
    async requestCompaction(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('SESSION_RUNTIME_INVALID_COMPACTION', 'Compaction request must be an object.');
      const unknown = Object.keys(input).find(key => !['sessionId', 'keepPercent', 'toolNoise'].includes(key));
      if (unknown || (input.keepPercent !== undefined && (!Number.isFinite(input.keepPercent) || input.keepPercent! <= 0 || input.keepPercent! > 1))
        || (input.toolNoise !== undefined && typeof input.toolNoise !== 'boolean')) throw new RpcError('SESSION_RUNTIME_INVALID_COMPACTION', 'Compaction request is invalid.');
      const requestedId = normalizeSessionId(input.sessionId); const selection = workerSelection(requestedId);
      if (selection.kind === 'unavailable') throw new RpcError('SESSION_WORKER_COMPACTION_UNAVAILABLE', 'Committed Worker state is unavailable.', true);
      if (selection.kind === 'worker') {
        if (input.toolNoise) return { kind: 'unsupported', message: 'Tool-noise compaction is not supported by Session-worker placement yet.' };
        if (!options?.worker?.ingress) throw new RpcError('SESSION_WORKER_COMPACTION_UNAVAILABLE', 'Session-worker compaction is unavailable.', true);
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
      const session = await requireSession(normalizeSessionId(input.sessionId));
      if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
        throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', 'patch must be an object.');
      }
      const supportedKeys = new Set(['cwd', 'model', 'childModelDefault', 'currentNode', 'displayName', 'compactThresholdTokens']);
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
      let normalizedThreshold: number | null | undefined;
      if (Object.prototype.hasOwnProperty.call(input.patch, 'compactThresholdTokens')) {
        const threshold = input.patch.compactThresholdTokens;
        if (threshold !== null && threshold !== undefined
          && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0)) {
          throw new RpcError('SESSION_RUNTIME_INVALID_SETTING', 'compactThresholdTokens must be a positive number or null.');
        }
        normalizedThreshold = threshold === null || threshold === undefined ? null : Math.floor(threshold);
      }
      const previous = settingsFromSession(session);
      const changed: Array<keyof SessionRuntimeSettingsPatchDto> = [];
      for (const [key, normalized] of normalizedStrings) {
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
    async control(input) {
      const sessionId = normalizeSessionId(input.sessionId);
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
