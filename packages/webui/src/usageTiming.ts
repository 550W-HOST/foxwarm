export type DurationSample = number | null | 'invalid'

export type DerivedRequestTiming = {
  apiDurationMs: DurationSample
  betweenRequestsMs: DurationSample
}

type TimingMessage = {
  role: string
  __meta?: {
    llmRequestTiming?: unknown
  }
}

type PersistedRequestTiming = {
  startedAt: number
  completedAt: number
  durationMs: number
}

const readPersistedRequestTiming = (value: unknown): PersistedRequestTiming | null | 'invalid' => {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'

  const timing = value as Partial<PersistedRequestTiming>
  if (
    typeof timing.startedAt !== 'number' || !Number.isFinite(timing.startedAt) || timing.startedAt < 0
    || typeof timing.completedAt !== 'number' || !Number.isFinite(timing.completedAt) || timing.completedAt < timing.startedAt
    || typeof timing.durationMs !== 'number' || !Number.isFinite(timing.durationMs) || timing.durationMs < 0
  ) {
    return 'invalid'
  }

  return {
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    durationMs: timing.durationMs,
  }
}

/**
 * Derive per-request API and inter-request durations without crossing a model
 * message whose historical timing is unavailable. Tool/user rows do not break
 * the chain because they are precisely the work performed between requests.
 */
export const deriveRequestTimings = (messages: readonly TimingMessage[]): DerivedRequestTiming[] => {
  let previousCompletedAt: number | null = null

  return messages.map((message) => {
    if (message.role !== 'model') {
      return { apiDurationMs: null, betweenRequestsMs: null }
    }

    const timing = readPersistedRequestTiming(message.__meta?.llmRequestTiming)
    if (timing === null) {
      previousCompletedAt = null
      return { apiDurationMs: null, betweenRequestsMs: null }
    }
    if (timing === 'invalid') {
      previousCompletedAt = null
      return { apiDurationMs: 'invalid', betweenRequestsMs: 'invalid' }
    }

    const betweenRequestsMs: DurationSample = previousCompletedAt === null
      ? null
      : timing.startedAt >= previousCompletedAt
        ? timing.startedAt - previousCompletedAt
        : 'invalid'
    previousCompletedAt = timing.completedAt
    return { apiDurationMs: timing.durationMs, betweenRequestsMs }
  })
}

export type DurationSummary = {
  totalMs: number | null
  unavailableCount: number
  invalidCount: number
}

export const summarizeDurationSamples = (samples: readonly DurationSample[]): DurationSummary => {
  let totalMs = 0
  let validCount = 0
  let unavailableCount = 0
  let invalidCount = 0

  for (const sample of samples) {
    if (typeof sample === 'number' && Number.isFinite(sample) && sample >= 0) {
      totalMs += sample
      validCount++
    } else if (sample === 'invalid') {
      invalidCount++
    } else {
      unavailableCount++
    }
  }

  return { totalMs: validCount > 0 ? totalMs : null, unavailableCount, invalidCount }
}

/** Compact duration with at most two non-zero units. */
export const formatCompactDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'invalid'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`

  let remainingSeconds = Math.floor(durationMs / 1000)
  const units = [
    { suffix: 'd', seconds: 86400 },
    { suffix: 'h', seconds: 3600 },
    { suffix: 'm', seconds: 60 },
    { suffix: 's', seconds: 1 },
  ]
  const parts: string[] = []
  for (const unit of units) {
    const value = Math.floor(remainingSeconds / unit.seconds)
    if (value > 0) {
      parts.push(`${value}${unit.suffix}`)
      remainingSeconds %= unit.seconds
      if (parts.length === 2) break
    }
  }
  return parts.join('') || '0s'
}

export const formatDetailedDuration = (durationMs: number): string => (
  `${formatCompactDuration(durationMs)} (${Math.round(durationMs)}ms)`
)