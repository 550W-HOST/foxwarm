export type LatestSessionListRequestGate = {
  latestRequestId: number
}

export const SESSION_LIST_VISIBLE_REFRESH_DELAY_MS = 1_000
export const SESSION_LIST_HIDDEN_REFRESH_DELAY_MS = 10_000

export type SessionListRefreshScheduler = {
  requestRefresh: () => void
  dispose: () => void
}

type SessionListRefreshSchedulerOptions = {
  getDelayMs?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export function getSessionListRefreshDelayMs(visibilityState: DocumentVisibilityState): number {
  return visibilityState === 'visible'
    ? SESSION_LIST_VISIBLE_REFRESH_DELAY_MS
    : SESSION_LIST_HIDDEN_REFRESH_DELAY_MS
}

export function createLatestSessionListRequestGate(): LatestSessionListRequestGate {
  return { latestRequestId: 0 }
}

export async function applyLatestSessionListRequest<T>(
  gate: LatestSessionListRequestGate,
  request: () => Promise<T>,
  apply: (value: T) => void,
): Promise<T> {
  const requestId = ++gate.latestRequestId
  const value = await request()
  if (requestId === gate.latestRequestId) {
    apply(value)
  }
  return value
}

export function createSessionListRefreshScheduler(
  refresh: () => Promise<unknown>,
  options: SessionListRefreshSchedulerOptions = {},
): SessionListRefreshScheduler {
  const getDelayMs = options.getDelayMs ?? (() => getSessionListRefreshDelayMs(document.visibilityState))
  const setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay))
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer as number))
  let timer: unknown | null = null
  let refreshInFlight = false
  let trailingRefreshRequested = false
  let disposed = false

  const armRefresh = () => {
    timer = setTimer(() => {
      timer = null
      if (disposed) return

      refreshInFlight = true
      void Promise.resolve()
        .then(refresh)
        .then(
          () => finishRefresh(),
          () => finishRefresh(),
        )
    }, getDelayMs())
  }

  const finishRefresh = () => {
    refreshInFlight = false
    if (disposed || !trailingRefreshRequested) return
    trailingRefreshRequested = false
    armRefresh()
  }

  return {
    requestRefresh: () => {
      if (disposed) return
      if (refreshInFlight) {
        trailingRefreshRequested = true
        return
      }
      if (timer !== null) return
      armRefresh()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      trailingRefreshRequested = false
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
  }
}
