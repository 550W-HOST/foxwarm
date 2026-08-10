import type { Session } from './types';

export type SessionRuntimeStateName = 'requesting-model' | 'running-tool' | 'waiting' | 'idle';
export type SessionRuntimeWaitingFor = 'sessions' | 'exec' | 'timer';
export type SessionRuntimeActivePhase = 'normal-turn' | 'compaction' | 'managed-step' | 'unknown';

export interface SessionRuntimeActiveDetails {
  iteration?: number;
  phase?: SessionRuntimeActivePhase;
  modelKey?: string;
  streamId?: string;
}

export interface SessionRuntimeToolDetails {
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
  satisfiedSessions?: string[];
  pendingSessions?: string[];
  timeoutSeconds?: number;
  timeoutAt?: number;
  waitExecIds?: string[];
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
}

export type ActiveSessionRuntimeStateInput = Omit<SessionRuntimeState, 'queueLength' | 'busy' | 'waiting'> & {
  state: 'requesting-model' | 'running-tool';
};

type RuntimeStateUpdateCallback = (sessionId: string) => void;

const activeRuntimeStates = new Map<string, ActiveSessionRuntimeStateInput>();
const catalogStubQueueLengths = new WeakMap<Session, number>();
let updateCallback: RuntimeStateUpdateCallback | undefined;

export function markSessionCatalogStub(session: Session, queueLength: number): void {
  catalogStubQueueLengths.set(session, Math.max(0, Math.floor(queueLength)));
}

export function clearSessionCatalogStub(session: Session): void {
  catalogStubQueueLengths.delete(session);
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
  const timeoutSeconds = typeof wait.timeoutSeconds === 'number' && Number.isFinite(wait.timeoutSeconds) && wait.timeoutSeconds > 0
    ? wait.timeoutSeconds
    : undefined;
  const startedAt = typeof wait.startedAt === 'number' && Number.isFinite(wait.startedAt)
    ? wait.startedAt
    : Date.now();

  const reason = typeof wait.reason === 'string' && wait.reason.trim() ? wait.reason.trim() : undefined;
  let waitingFor: SessionRuntimeWaitingFor | undefined;
  if (waitAllSessions?.length) {
    waitingFor = 'sessions';
  } else if (waitExecIds?.length) {
    waitingFor = 'exec';
  } else if (timeoutSeconds !== undefined) {
    waitingFor = 'timer';
  }

  if (!waitingFor) {
    return undefined;
  }

  return {
    waitId: wait.id,
    waitingFor,
    reason,
    waitAllSessions,
    satisfiedSessions: waitAllSessions?.length ? satisfiedSessions : undefined,
    pendingSessions,
    timeoutSeconds,
    timeoutAt: timeoutSeconds !== undefined ? startedAt + timeoutSeconds * 1000 : undefined,
    waitExecIds,
  };
}

function mergeActiveState(session: Session, active: ActiveSessionRuntimeStateInput): SessionRuntimeState {
  return {
    ...active,
    since: active.since || active.tool?.startedAt || Date.now(),
    queueLength: getEffectiveSessionQueueLength(session),
    busy: true,
  };
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
      ? { ...state.tool, startedAt: state.tool.startedAt || Date.now() }
      : undefined,
  });
  updateCallback?.(sessionId);
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

export function buildSessionRuntimeState(session: Session): SessionRuntimeState {
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

  if (queueLength > 0) {
    return {
      state: 'requesting-model',
      note: 'Session has queued work awaiting processing.',
      queueLength,
      busy: false,
      active: { phase: 'unknown' },
    };
  }

  return {
    state: 'idle',
    queueLength,
    busy: false,
  };
}

export function formatSessionRuntimeStateSummary(runtimeState: SessionRuntimeState | undefined): string {
  if (!runtimeState) {
    return 'idle';
  }

  if (runtimeState.state === 'running-tool') {
    const toolName = runtimeState.tool?.name || 'tool';
    const index = typeof runtimeState.tool?.index === 'number' && typeof runtimeState.tool?.total === 'number'
      ? ` ${runtimeState.tool.index + 1}/${runtimeState.tool.total}`
      : '';
    return `running-tool:${toolName}${index}`;
  }

  if (runtimeState.state === 'requesting-model') {
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

    if (waiting.waitingFor === 'sessions') {
      const total = waiting.waitAllSessions?.length || 0;
      const satisfied = waiting.satisfiedSessions?.length || 0;
      return total > 0 ? `waiting:sessions ${satisfied}/${total}` : 'waiting:sessions';
    }

    if (waiting.waitingFor === 'exec') {
      const count = waiting.waitExecIds?.length || 0;
      return count > 0 ? `waiting:exec ${count}` : 'waiting:exec';
    }

    if (waiting.waitingFor === 'timer') {
      return waiting.timeoutSeconds !== undefined ? `waiting:timer ${waiting.timeoutSeconds}s` : 'waiting:timer';
    }

    return `waiting:${waiting.waitingFor}`;
  }

  return 'idle';
}
