import type { Session } from './types';

export type SessionRuntimeStateName = 'requesting-model' | 'running-tool' | 'waiting' | 'idle';
export type SessionRuntimeWaitingFor = 'all-sessions' | 'any-session' | 'exec' | 'input' | 'fallback';
export type SessionRuntimeActivePhase = 'normal-turn' | 'compaction' | 'managed-step' | 'unknown';

export interface SessionRuntimeActiveDetails {
  iteration?: number;
  phase?: SessionRuntimeActivePhase;
  modelKey?: string;
  streamId?: string;
}

export interface SessionRuntimeToolDetails {
  invocationName?: string;
  source?: 'builtin' | 'node' | 'mcp';
  server?: string;
  action?: string;
  target?: string;
  id?: string;
  name: string;
  index?: number;
  total?: number;
  executionNode?: string;
  argsPreview?: string;
  startedAt: number;
}

export interface SessionRuntimeWaitingDetails {
  waitId: string;
  waitingFor: SessionRuntimeWaitingFor;
  reason?: string;
  waitAllSessions?: string[];
  waitAnySessions?: string[];
  satisfiedSessions?: string[];
  pendingSessions?: string[];
  timeoutSeconds?: number;
  timeoutAt?: number;
  waitExecIds?: string[];
  waitForInput?: true;
}

export interface SessionRuntimeRetryDetails {
  final?: true;
  attempt: number;
  maxAttempts: number;
  nextAttempt?: number;
  retryAt?: number;
  reason?: string;
}

export interface SessionRuntimeCompactionDetails {
  operationId: string;
  phase: 'planning' | 'enqueueing' | 'ready' | 'committing';
  background: boolean;
  retry?: SessionRuntimeRetryDetails;
}

export interface SessionRuntimeState {
  state: SessionRuntimeStateName;
  since?: number;
  note?: string;
  queueLength: number;
  busy: boolean;
  active?: SessionRuntimeActiveDetails;
  tool?: SessionRuntimeToolDetails;
  waiting?: SessionRuntimeWaitingDetails;
  retry?: SessionRuntimeRetryDetails;
  stopping?: true;
  compaction?: SessionRuntimeCompactionDetails;
}

export type ActiveSessionRuntimeStateInput = Omit<SessionRuntimeState, 'queueLength' | 'busy' | 'waiting'> & {
  state: 'requesting-model' | 'running-tool';
};

type RuntimeStateUpdateCallback = (sessionId: string) => void;

const activeRuntimeStates = new Map<string, ActiveSessionRuntimeStateInput>();
const compactRuntimeStates = new Map<string, SessionRuntimeCompactionDetails>();
const catalogStubQueueLengths = new WeakMap<Session, number>();
let updateCallback: RuntimeStateUpdateCallback | undefined;

function normalizeToolArgsPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let preview: string;
  if (typeof value === 'string') preview = value;
  else {
    try {
      const serialized = JSON.stringify(value);
      preview = typeof serialized === 'string' ? serialized : String(value);
    } catch {
      preview = String(value);
    }
  }
  return preview.length > 4096 ? `${preview.slice(0, 4095)}…` : preview;
}

export function markSessionCatalogStub(session: Session, queueLength: number): void {
  catalogStubQueueLengths.set(session, Math.max(0, Math.floor(queueLength)));
}

export function clearSessionCatalogStub(session: Session): void {
  catalogStubQueueLengths.delete(session);
}

export function isSessionCatalogStub(session: Session): boolean {
  return catalogStubQueueLengths.has(session);
}

export function getEffectiveSessionQueueLength(session: Session): number {
  const catalogCount = catalogStubQueueLengths.get(session);
  return catalogCount === undefined ? (Array.isArray(session.queue) ? session.queue.length : 0) : catalogCount;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function getWaitAllPendingSessions(waitAll: { sessions?: unknown; satisfiedSessions?: unknown } | undefined): string[] | undefined {
  const sessions = normalizeStringArray(waitAll?.sessions);
  if (!sessions?.length) {
    return undefined;
  }

  const satisfied = new Set(normalizeStringArray(waitAll?.satisfiedSessions) || []);
  return sessions.filter(sessionId => !satisfied.has(sessionId));
}

function deriveWaitingDetails(session: Session): SessionRuntimeWaitingDetails | undefined {
  const wait = session.meta?.wait;
  if (!wait || typeof wait !== 'object' || typeof wait.id !== 'string') {
    return undefined;
  }

  const waitAll = wait.waitAll && typeof wait.waitAll === 'object' ? wait.waitAll as any : undefined;
  const waitAllSessions = normalizeStringArray(waitAll?.sessions);
  const satisfiedSessions = normalizeStringArray(waitAll?.satisfiedSessions) || [];
  const pendingSessions = getWaitAllPendingSessions(waitAll);
  const waitExecIds = normalizeStringArray(wait.waitExecIds);
  const waitAnySessions = normalizeStringArray(wait.waitAnySessions);
  const waitForInput = wait.waitForInput === true ? true : undefined;
  const timeoutSeconds = typeof wait.timeoutSeconds === 'number' && Number.isFinite(wait.timeoutSeconds) && wait.timeoutSeconds > 0
    ? wait.timeoutSeconds
    : undefined;
  const startedAt = typeof wait.startedAt === 'number' && Number.isFinite(wait.startedAt)
    ? wait.startedAt
    : Date.now();

  const reason = typeof wait.reason === 'string' && wait.reason.trim() ? wait.reason.trim() : undefined;
  let waitingFor: SessionRuntimeWaitingFor | undefined;
  if (waitAllSessions?.length) {
    waitingFor = 'all-sessions';
  } else if (waitAnySessions?.length) {
    waitingFor = 'any-session';
  } else if (waitExecIds?.length) {
    waitingFor = 'exec';
  } else if (waitForInput) {
    waitingFor = 'input';
  } else if (timeoutSeconds !== undefined) {
    waitingFor = 'fallback';
  }

  if (!waitingFor) {
    return undefined;
  }

  return {
    waitId: wait.id,
    waitingFor,
    reason,
    waitAllSessions,
    waitAnySessions,
    satisfiedSessions: waitAllSessions?.length ? satisfiedSessions : undefined,
    pendingSessions,
    timeoutSeconds,
    timeoutAt: timeoutSeconds !== undefined ? startedAt + timeoutSeconds * 1000 : undefined,
    waitExecIds,
    waitForInput,
  };
}

function mergeActiveState(session: Session, active: ActiveSessionRuntimeStateInput): SessionRuntimeState {
  return {
    ...active,
    ...(active.retry ? { retry: boundRuntimeRetry(active.retry) } : {}),
    since: active.since || active.tool?.startedAt || Date.now(),
    queueLength: getEffectiveSessionQueueLength(session),
    busy: true,
  };
}

/** Bounded transient retry/compact projections; no history or scheduling ownership. */
export function boundRuntimeRetry(retry: SessionRuntimeRetryDetails): SessionRuntimeRetryDetails {
  return {
    ...(retry.final ? { final: true as const } : {}),
    attempt: Math.max(1, Math.floor(retry.attempt)), maxAttempts: Math.max(1, Math.floor(retry.maxAttempts)),
    ...(retry.nextAttempt === undefined ? {} : { nextAttempt: Math.max(1, Math.floor(retry.nextAttempt)) }),
    ...(retry.retryAt === undefined ? {} : { retryAt: Math.max(0, Math.floor(retry.retryAt)) }),
    ...(retry.reason ? { reason: retry.reason.replace(/\s+/g, ' ').trim().slice(0, 1024) } : {}),
  };
}

export function setCompactionRuntimeState(sessionId: string, state: SessionRuntimeCompactionDetails): void {
  compactRuntimeStates.set(sessionId, { ...state, ...(state.retry ? { retry: boundRuntimeRetry(state.retry) } : {}) });
  updateCallback?.(sessionId);
}

export function clearCompactionRuntimeState(sessionId: string, operationId: string): void {
  if (compactRuntimeStates.get(sessionId)?.operationId !== operationId) return;
  compactRuntimeStates.delete(sessionId);
  updateCallback?.(sessionId);
}

export function setSessionRuntimeStateUpdateCallback(callback: RuntimeStateUpdateCallback | undefined): void {
  updateCallback = callback;
}

export function setActiveSessionRuntimeState(sessionId: string, state: ActiveSessionRuntimeStateInput): void {
  if (!sessionId) {
    return;
  }

  activeRuntimeStates.set(sessionId, {
    ...state,
    since: state.since || Date.now(),
    tool: state.tool
      ? {
        ...state.tool,
        argsPreview: normalizeToolArgsPreview(state.tool.argsPreview),
        startedAt: state.tool.startedAt || Date.now(),
      }
      : undefined,
  });
  updateCallback?.(sessionId);
}

export function beginCompactionSessionRuntimeState(sessionId: string): () => void {
  if (!sessionId) return () => {};

  const state: ActiveSessionRuntimeStateInput = {
    state: 'requesting-model',
    since: Date.now(),
    active: { phase: 'compaction' },
  };
  activeRuntimeStates.set(sessionId, state);
  updateCallback?.(sessionId);

  return () => {
    if (activeRuntimeStates.get(sessionId) !== state) return;
    activeRuntimeStates.delete(sessionId);
    updateCallback?.(sessionId);
  };
}

export function clearActiveSessionRuntimeState(sessionId: string): void {
  if (!sessionId || !activeRuntimeStates.delete(sessionId)) {
    return;
  }

  updateCallback?.(sessionId);
}

export function getActiveSessionRuntimeState(sessionId: string): ActiveSessionRuntimeStateInput | undefined {
  return activeRuntimeStates.get(sessionId);
}

function deriveSessionRuntimeState(session: Session): SessionRuntimeState {
  const queueLength = getEffectiveSessionQueueLength(session);
  const active = getActiveSessionRuntimeState(session.id);
  if (active) {
    return mergeActiveState(session, active);
  }

  const waiting = deriveWaitingDetails(session);
  if (waiting) {
    return {
      state: 'waiting',
      since: typeof session.meta.wait?.startedAt === 'number' ? session.meta.wait.startedAt : undefined,
      queueLength,
      busy: false,
      waiting,
    };
  }

  if (session.busy) {
    return {
      state: 'requesting-model',
      since: session.busyStartedAt,
      note: 'Session is busy, but exact runtime phase is not available.',
      queueLength,
      busy: true,
      active: {
        phase: 'unknown',
      },
    };
  }

  return {
    state: 'idle',
    queueLength,
    busy: false,
  };
}

export function buildSessionRuntimeState(session: Session): SessionRuntimeState {
  const state = deriveSessionRuntimeState(session);
  const compaction = compactRuntimeStates.get(session.id);
  return { ...state, ...(session.stopping && state.busy ? { stopping: true as const } : {}), ...(state.retry ? { retry: { ...state.retry } } : {}), ...(compaction ? { compaction: { ...compaction, ...(compaction.retry ? { retry: { ...compaction.retry } } : {}) } } : {}) };
}

export function formatSessionRuntimeStateSummary(runtimeState: SessionRuntimeState | undefined): string {
  if (!runtimeState) {
    return 'idle';
  }

  if (runtimeState.stopping) return 'stopping';
  if (runtimeState.retry) return `retrying ${runtimeState.retry.nextAttempt || runtimeState.retry.attempt}/${runtimeState.retry.maxAttempts}`;

  if (runtimeState.state === 'running-tool') {
    const toolName = runtimeState.tool?.name || 'tool';
    const index = typeof runtimeState.tool?.index === 'number' && typeof runtimeState.tool?.total === 'number'
      ? ` ${runtimeState.tool.index + 1}/${runtimeState.tool.total}`
      : '';
    return `running-tool:${toolName}${index}`;
  }

  if (runtimeState.state === 'requesting-model') {
    if (runtimeState.active?.phase === 'compaction') return 'compacting';
    const phase = runtimeState.active?.phase && runtimeState.active.phase !== 'normal-turn'
      ? `:${runtimeState.active.phase}`
      : '';
    return `requesting-model${phase}`;
  }

  if (runtimeState.state === 'waiting') {
    const waiting = runtimeState.waiting;
    if (!waiting) {
      return 'waiting';
    }

    if (waiting.waitingFor === 'all-sessions') {
      const total = waiting.waitAllSessions?.length || 0;
      const satisfied = waiting.satisfiedSessions?.length || 0;
      return total > 0 ? `waiting:all ${satisfied}/${total}` : 'waiting:all';
    }

    if (waiting.waitingFor === 'any-session') return `waiting:any ${waiting.waitAnySessions?.length || 0}`;

    if (waiting.waitingFor === 'exec') {
      const count = waiting.waitExecIds?.length || 0;
      return count > 0 ? `waiting:exec ${count}` : 'waiting:exec';
    }

    if (waiting.waitingFor === 'input') return 'waiting:input';
    if (waiting.waitingFor === 'fallback') return waiting.timeoutSeconds !== undefined ? `waiting:fallback ${waiting.timeoutSeconds}s` : 'waiting:fallback';

    return `waiting:${waiting.waitingFor}`;
  }

  return 'idle';
}
