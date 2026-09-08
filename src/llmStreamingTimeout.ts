export const DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

export type StreamingTimeoutKind = 'first-content' | 'content-inactivity' | 'hard-deadline';

type TimerHandle = { unref?: () => void };

type TimerHooks = {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(timer: TimerHandle): void;
};

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const defaultTimerHooks: TimerHooks = {
  set: (callback, delayMs) => nativeSetTimeout(callback, delayMs),
  clear: timer => nativeClearTimeout(timer as NodeJS.Timeout),
};
let timerHooks: TimerHooks = defaultTimerHooks;

export type StreamingAttemptWatchdog = {
  markMeaningfulProgress(): void;
  finish(): void;
};

function timeoutError(kind: StreamingTimeoutKind, timeoutMs: number): Error {
  const label = kind === 'first-content'
    ? 'before the first model output activity'
    : kind === 'content-inactivity'
      ? 'while waiting for further model output activity'
      : 'at the explicit caller deadline';
  const error: any = new Error(`Streaming LLM request timed out ${label} after ${timeoutMs}ms.`);
  error.code = 'LLM_STREAM_TIMEOUT';
  error.timeoutKind = kind;
  return error;
}

export function createStreamingAttemptWatchdog(options: {
  hardTimeoutMs?: number;
  onTimeout(error: Error, kind: StreamingTimeoutKind): void;
}): StreamingAttemptWatchdog {
  let finished = false;
  let phaseTimer: TimerHandle | undefined;
  let hardTimer: TimerHandle | undefined;
  let phaseGeneration = 0;

  const clearPhase = () => {
    if (!phaseTimer) return;
    timerHooks.clear(phaseTimer);
    phaseTimer = undefined;
  };
  const fire = (kind: StreamingTimeoutKind, timeoutMs: number) => {
    if (finished) return;
    finished = true;
    clearPhase();
    if (hardTimer) {
      timerHooks.clear(hardTimer);
      hardTimer = undefined;
    }
    options.onTimeout(timeoutError(kind, timeoutMs), kind);
  };
  const schedulePhase = (kind: 'first-content' | 'content-inactivity', timeoutMs: number) => {
    clearPhase();
    const generation = ++phaseGeneration;
    phaseTimer = timerHooks.set(() => {
      if (generation === phaseGeneration) fire(kind, timeoutMs);
    }, timeoutMs);
    phaseTimer.unref?.();
  };

  schedulePhase('first-content', DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS);
  if (options.hardTimeoutMs !== undefined) {
    hardTimer = timerHooks.set(
      () => fire('hard-deadline', options.hardTimeoutMs!),
      options.hardTimeoutMs,
    );
    hardTimer.unref?.();
  }

  return {
    markMeaningfulProgress() {
      if (finished) return;
      schedulePhase('content-inactivity', DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS);
    },
    finish() {
      if (finished) return;
      finished = true;
      phaseGeneration += 1;
      clearPhase();
      if (hardTimer) {
        timerHooks.clear(hardTimer);
        hardTimer = undefined;
      }
    },
  };
}

export function setStreamingTimeoutTestHooks(hooks?: TimerHooks): void {
  timerHooks = hooks || defaultTimerHooks;
}
