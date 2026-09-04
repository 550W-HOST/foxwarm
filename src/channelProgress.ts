import { logger } from './common';
import type { ChannelTurnProgress } from './types';

export const CHANNEL_PROGRESS_MIN_INTERVAL_MS = 30_000;
export const CHANNEL_PROGRESS_MAX_INTERVAL_MS = 1_800_000;
const CHANNEL_PROGRESS_TTL_MS = 3_600_000;
const MAX_TOOL_NAMES = 6;
const MAX_TOOL_NAME_LENGTH = 32;
const MAX_TOOL_COUNT = 999;
const MAX_SUMMARY_LENGTH = 240;
const MAX_RUNNING_CALLS = 256;
const MAX_TARGETS_PER_REPORT = 64;
const MAX_STATES = 4096;

type TimerHandle = ReturnType<typeof setTimeout>;

export type ChannelProgressTarget = {
  channelInstanceId: string;
  conversationId: string;
  intervalMs: number;
  send: (text: string) => Promise<void>;
};

type TargetState = {
  turnId: string;
  target: ChannelProgressTarget;
  startedByName: Map<string, number>;
  reportedByName: Map<string, number>;
  runningById: Map<string, string>;
  timer?: TimerHandle;
  timerInFlight?: Promise<void>;
  nextDueAt?: number;
  lastTouchedAt: number;
  closing: boolean;
  generation: number;
};

export type ChannelProgressClock = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
};

function sanitizeToolName(value: unknown): string {
  const cleaned = String(value || 'tool')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\r\n\t`*_~|<>]/g, '')
    .trim()
    .slice(0, MAX_TOOL_NAME_LENGTH);
  return cleaned || 'tool';
}

function addCount(map: Map<string, number>, name: string, amount = 1): void {
  map.set(name, Math.min(MAX_TOOL_COUNT, (map.get(name) || 0) + amount));
}

function boundedName(map: Map<string, number>, name: string): string {
  if (map.has(name) || map.size < MAX_TOOL_NAMES - 1) return name;
  return 'other';
}

function renderCounts(counts: Map<string, number>): string {
  const entries = [...counts.entries()].filter(([, count]) => count > 0).slice(0, MAX_TOOL_NAMES);
  const hidden = Math.max(0, counts.size - entries.length);
  const body = entries.map(([name, count]) => `${name} ×${Math.min(MAX_TOOL_COUNT, count)}`).join(' · ');
  return `${body}${hidden ? ` · +${hidden} more` : ''}`.slice(0, MAX_SUMMARY_LENGTH);
}

function buildNewStartsSummary(state: TargetState, standalone: boolean): string | undefined {
  const newer = new Map<string, number>();
  for (const [name, total] of state.startedByName) {
    const delta = Math.max(0, total - (state.reportedByName.get(name) || 0));
    if (delta) newer.set(name, delta);
  }
  if (newer.size) {
    const prefix = standalone ? '⏳ Tools: ' : 'Tools: ';
    return `${prefix}${renderCounts(newer)}`.slice(0, MAX_SUMMARY_LENGTH);
  }
  return undefined;
}

function buildTimerSummary(state: TargetState): string | undefined {
  const newStarts = buildNewStartsSummary(state, true);
  if (newStarts) return newStarts;
  if (state.runningById.size) {
    const running = new Map<string, number>();
    for (const name of state.runningById.values()) addCount(running, name);
    return `⏳ Tools running: ${renderCounts(running)}`.slice(0, MAX_SUMMARY_LENGTH);
  }
  return undefined;
}

function consumeBaseline(state: TargetState): void {
  state.reportedByName = new Map(state.startedByName);
}

function consumeBaselineThrough(state: TargetState, startedSnapshot: Map<string, number>): void {
  for (const [name, total] of startedSnapshot) {
    state.reportedByName.set(name, Math.max(state.reportedByName.get(name) || 0, total));
  }
}

function key(turnId: string, target: Pick<ChannelProgressTarget, 'channelInstanceId' | 'conversationId'>): string {
  return `${turnId}\u0000${target.channelInstanceId}\u0000${target.conversationId}`;
}

export class ChannelProgressCoordinator {
  private readonly states = new Map<string, TargetState>();
  private generation = 0;

  constructor(private readonly clock: ChannelProgressClock = {
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: timer => clearTimeout(timer),
  }) {}

  report(turnId: string, targets: ChannelProgressTarget[], progress: ChannelTurnProgress): void {
    this.cleanupStale();
    if (progress.type === 'llm-start') return;
    const relevantCalls = progress.type === 'tool-calls-start'
      ? progress.calls.filter(call => call.name !== 'wait').slice(0, 128)
      : undefined;
    for (const target of targets.slice(0, MAX_TARGETS_PER_REPORT)) {
      const stateKey = key(turnId, target);
      let state = this.states.get(stateKey);
      if (state) {
        if (state.closing) continue;
        state.target = target;
        state.lastTouchedAt = this.clock.now();
      }
      if (progress.type === 'tool-calls-start' && !relevantCalls?.length) continue;
      if (!state) {
        if (progress.type === 'tool-calls-finish') continue;
        if (this.states.size >= MAX_STATES) this.evictOldest();
        state = {
          turnId,
          target,
          startedByName: new Map(),
          reportedByName: new Map(),
          runningById: new Map(),
          lastTouchedAt: this.clock.now(),
          closing: false,
          generation: this.generation,
        };
        this.states.set(stateKey, state);
      }
      if (progress.type === 'tool-calls-start') {
        for (const call of relevantCalls!) {
          const name = boundedName(state.startedByName, sanitizeToolName(call.name));
          const id = String(call.id || '').slice(0, 256);
          addCount(state.startedByName, name);
          if (id && (state.runningById.has(id) || state.runningById.size < MAX_RUNNING_CALLS)) state.runningById.set(id, name);
        }
        if (!state.timer && !state.timerInFlight) {
          state.nextDueAt = this.clock.now() + state.target.intervalMs;
          this.arm(stateKey, state);
        }
      } else {
        for (const result of progress.results.slice(0, 128)) {
          const id = String(result.id || '').slice(0, 256);
          if (id) state.runningById.delete(id);
        }
      }
    }
  }

  decorate(turnId: string | undefined, target: Pick<ChannelProgressTarget, 'channelInstanceId' | 'conversationId'>, text: string): string {
    if (!turnId || !text.trim()) return text;
    const state = this.states.get(key(turnId, target));
    if (!state) return text;
    state.lastTouchedAt = this.clock.now();
    const summary = buildNewStartsSummary(state, false);
    if (!summary) return text;
    consumeBaseline(state);
    return `${summary}\n\n${text}`;
  }

  async finish(turnId: string): Promise<void> {
    const finishGeneration = this.generation;
    const selected = [...this.states.entries()].filter(([, state]) => state.turnId === turnId);
    for (const [stateKey, state] of selected) {
      state.closing = true;
      if (state.timer) this.clock.clearTimer(state.timer);
      state.timer = undefined;
      this.states.delete(stateKey);
      if (state.timerInFlight) continue;
      const summary = buildNewStartsSummary(state, true);
      if (!summary) continue;
      consumeBaseline(state);
      queueMicrotask(() => {
        if (this.generation !== finishGeneration || state.generation !== finishGeneration) return;
        void state.target.send(summary).catch(error => {
          logger.warn({ err: error, channelInstanceId: state.target.channelInstanceId }, 'Channel progress final flush failed');
        });
      });
    }
  }

  reset(): void {
    this.generation += 1;
    for (const state of this.states.values()) {
      state.closing = true;
      if (state.timer) this.clock.clearTimer(state.timer);
    }
    this.states.clear();
  }

  sizeForTests(): number { return this.states.size; }

  private arm(stateKey: string, state: TargetState): void {
    if (!this.isCurrent(stateKey, state) || state.timer || state.timerInFlight) return;
    const dueAt = state.nextDueAt ?? (this.clock.now() + state.target.intervalMs);
    state.timer = this.clock.setTimer(() => {
      state.timer = undefined;
      if (!this.isCurrent(stateKey, state)) return;
      const scheduledDueAt = dueAt;
      const inFlight = this.onTimer(stateKey, state);
      state.timerInFlight = inFlight;
      void inFlight.finally(() => {
        if (state.timerInFlight === inFlight) state.timerInFlight = undefined;
        if (!this.isCurrent(stateKey, state)) return;
        if (state.runningById.size || buildNewStartsSummary(state, true)) {
          let nextDueAt = scheduledDueAt + state.target.intervalMs;
          const now = this.clock.now();
          while (nextDueAt <= now) nextDueAt += state.target.intervalMs;
          state.nextDueAt = nextDueAt;
          this.arm(stateKey, state);
        }
      });
    }, Math.max(0, dueAt - this.clock.now()));
  }

  private async onTimer(stateKey: string, state: TargetState): Promise<void> {
    if (!this.isCurrent(stateKey, state)) return;
    if (this.clock.now() - state.lastTouchedAt > CHANNEL_PROGRESS_TTL_MS) {
      state.closing = true;
      this.states.delete(stateKey);
      return;
    }
    const summary = buildTimerSummary(state);
    if (summary) {
      const startedSnapshot = new Map(state.startedByName);
      try {
        await state.target.send(summary);
        consumeBaselineThrough(state, startedSnapshot);
      }
      catch (error) { logger.warn({ err: error, channelInstanceId: state.target.channelInstanceId }, 'Channel progress timer delivery failed'); }
    }
  }

  private cleanupStale(): void {
    const now = this.clock.now();
    for (const [stateKey, state] of this.states) {
      if (now - state.lastTouchedAt <= CHANNEL_PROGRESS_TTL_MS) continue;
      state.closing = true;
      if (state.timer) this.clock.clearTimer(state.timer);
      this.states.delete(stateKey);
    }
  }

  private evictOldest(): void {
    let oldest: [string, TargetState] | undefined;
    for (const entry of this.states) {
      if (!oldest || entry[1].lastTouchedAt < oldest[1].lastTouchedAt) oldest = entry;
    }
    if (!oldest) return;
    oldest[1].closing = true;
    if (oldest[1].timer) this.clock.clearTimer(oldest[1].timer);
    this.states.delete(oldest[0]);
  }

  private isCurrent(stateKey: string, state: TargetState): boolean {
    return !state.closing && state.generation === this.generation && this.states.get(stateKey) === state;
  }
}

export const channelProgressCoordinator = new ChannelProgressCoordinator();
