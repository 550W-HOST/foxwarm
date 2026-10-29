import { getRuntimeStatusView } from './runtimeStatus'
export type SessionRuntimeStateName = 'requesting-model' | 'running-tool' | 'waiting' | 'idle' | 'llm-failed'
export type SessionRuntimeWaitingFor = 'all-sessions' | 'any-session' | 'exec' | 'input' | 'fallback'

export interface SessionRuntimeRetryDetails {
  final?: true;
  attempt: number
  maxAttempts: number
  nextAttempt?: number
  retryAt?: number
  reason?: string
}

export interface SessionRuntimeCompactionDetails {
  operationId: string
  phase: 'planning' | 'enqueueing' | 'ready' | 'committing'
  background: boolean
  retry?: SessionRuntimeRetryDetails
}

export interface SessionRuntimeState {
  state: SessionRuntimeStateName
  since?: number
  note?: string
  retry?: SessionRuntimeRetryDetails
  processing?: true
  stopping?: true
  compaction?: SessionRuntimeCompactionDetails
  queueLength: number
  busy: boolean
  active?: {
    iteration?: number
    phase?: 'normal-turn' | 'compaction' | 'managed-step' | 'unknown'
    modelKey?: string
    streamId?: string
  }
  tool?: {
  invocationName?: string
    source?: 'builtin' | 'node' | 'mcp'
    server?: string
    action?: string
    target?: string
    id?: string
    name: string
    index?: number
    total?: number
    executionNode?: string
    argsPreview?: string
    startedAt: number
  }
  waiting?: {
    waitId: string
    waitingFor: SessionRuntimeWaitingFor
    reason?: string
    waitAllSessions?: string[]
    waitAnySessions?: string[]
    satisfiedSessions?: string[]
    pendingSessions?: string[]
    timeoutSeconds?: number
    timeoutAt?: number
    waitExecIds?: string[]
    waitForInput?: true
  }
}

export interface RuntimeStateSessionLike {
  busy?: boolean
  runtimeState?: SessionRuntimeState
}

/** Inactive outcomes that can accept ordinary input or an eligible Continue. */
export function isRuntimeStateInactiveName(state: string | undefined): boolean {
  return state === 'idle' || state === 'llm-failed'
}

export function isRuntimeStateActive(runtimeState?: SessionRuntimeState | null): boolean {
  return runtimeState?.state === 'requesting-model' || runtimeState?.state === 'running-tool'
}

export function isSessionRuntimeActive(session: RuntimeStateSessionLike): boolean {
  if (session.runtimeState) {
    return isRuntimeStateActive(session.runtimeState)
  }
  return !!session.busy
}

export function getSessionRuntimeStateName(session: RuntimeStateSessionLike): SessionRuntimeStateName {
  if (session.runtimeState?.state) {
    return session.runtimeState.state
  }
  return session.busy ? 'requesting-model' : 'idle'
}

export function getRuntimeStateSummary(runtimeState?: SessionRuntimeState | null, fallbackBusy = false): string {
  return getRuntimeStatusView(runtimeState || undefined, fallbackBusy)?.label || 'idle'
}

export function getSessionRuntimeTone(session: RuntimeStateSessionLike): 'accent' | 'special' | 'warning' | 'danger' | 'muted' {
  return getRuntimeStatusView(session.runtimeState, !!session.busy)?.tone || 'muted'
}

export function getSessionRuntimeSummary(session: RuntimeStateSessionLike): string {
  return getRuntimeStateSummary(session.runtimeState, !!session.busy)
}
