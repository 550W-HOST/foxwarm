export type LatestSessionListRequestGate = {
  latestRequestId: number
}

export const SESSION_LIST_REFRESH_DELAY_MS = 200

export type SessionListRefreshScheduler = {
  requestRefresh: () => void
  dispose: () => void
}

type SessionListRefreshSchedulerOptions = {
  delayMs?: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
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
  const delayMs = options.delayMs ?? SESSION_LIST_REFRESH_DELAY_MS
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
    }, delayMs)
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
