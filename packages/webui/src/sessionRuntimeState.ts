export type SessionRuntimeStateName = 'requesting-model' | 'running-tool' | 'waiting' | 'idle'
export type SessionRuntimeWaitingFor = 'all-sessions' | 'any-session' | 'exec' | 'input' | 'fallback'

export interface SessionRuntimeState {
  state: SessionRuntimeStateName
  since?: number
  note?: string
  queueLength: number
  busy: boolean
  active?: {
    iteration?: number
    phase?: 'normal-turn' | 'compaction' | 'managed-step' | 'unknown'
    modelKey?: string
    streamId?: string
  }
  tool?: {
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
  if (!runtimeState) {
    return fallbackBusy ? 'thinking' : 'idle'
  }

  if (runtimeState.state === 'requesting-model') {
    return runtimeState.active?.phase && runtimeState.active.phase !== 'normal-turn'
      ? `thinking · ${runtimeState.active.phase}`
      : 'thinking'
  }

  if (runtimeState.state === 'running-tool') {
    const toolName = runtimeState.tool?.name || 'tool'
    const index = typeof runtimeState.tool?.index === 'number' && typeof runtimeState.tool?.total === 'number'
      ? ` ${runtimeState.tool.index + 1}/${runtimeState.tool.total}`
      : ''
    return `tool: ${toolName}${index}`
  }

  if (runtimeState.state === 'waiting') {
    const waiting = runtimeState.waiting
    if (!waiting) return 'waiting'
    if (waiting.waitingFor === 'all-sessions') {
      const total = waiting.waitAllSessions?.length || 0
      const satisfied = waiting.satisfiedSessions?.length || 0
      return total > 0 ? `waiting: sessions ${satisfied}/${total}` : 'waiting: sessions'
    }
    if (waiting.waitingFor === 'any-session') return `waiting: any session ${waiting.waitAnySessions?.length || 0}`
    if (waiting.waitingFor === 'exec') {
      const count = waiting.waitExecIds?.length || 0
      return count > 0 ? `waiting: exec ${count}` : 'waiting: exec'
    }
    if (waiting.waitingFor === 'input') return 'waiting: input'
    if (waiting.waitingFor === 'fallback') {
      return waiting.timeoutSeconds ? `waiting: fallback ${waiting.timeoutSeconds}s` : 'waiting: fallback'
    }
    return `waiting: ${waiting.waitingFor}`
  }

  return 'idle'
}

export function getSessionRuntimeSummary(session: RuntimeStateSessionLike): string {
  return getRuntimeStateSummary(session.runtimeState, !!session.busy)
}
