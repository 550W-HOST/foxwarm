import type { LlmRequestTiming } from './types';

export type CompletedLlmRequestTiming = {
  completedAt: number;
  durationMs: number;
};

/** Convert a monotonic logical-request duration into persisted wall boundaries. */
export function toPersistedLlmRequestTiming(
  timing: CompletedLlmRequestTiming | undefined,
): LlmRequestTiming | undefined {
  if (
    !timing
    || !Number.isFinite(timing.completedAt)
    || timing.completedAt < 0
    || !Number.isFinite(timing.durationMs)
    || timing.durationMs < 0
  ) {
    return undefined;
  }

  const startedAt = timing.completedAt - timing.durationMs;
  if (!Number.isFinite(startedAt) || startedAt < 0) return undefined;
  return { startedAt, completedAt: timing.completedAt, durationMs: timing.durationMs };
}