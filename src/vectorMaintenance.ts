export type VectorMaintenanceTrigger = 'startup' | 'mutation-threshold' | 'periodic' | 'retry';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

/**
 * A fair owner-local barrier. Ordinary table operations may overlap, but once
 * an exclusive operation is queued no later ordinary operation can jump ahead.
 */
export class FairTableOperationGate {
  private activeRegular = 0;
  private exclusiveActive = false;
  private readonly regularWaiters: Array<Deferred<void>> = [];
  private readonly exclusiveWaiters: Array<{
    run: () => Promise<unknown>;
    completion: Deferred<unknown>;
  }> = [];

  async runRegular<T>(run: () => Promise<T>): Promise<T> {
    await this.acquireRegular();
    try {
      return await run();
    } finally {
      this.releaseRegular();
    }
  }

  runExclusive<T>(run: () => Promise<T>): Promise<T> {
    const completion = deferred<T>();
    this.exclusiveWaiters.push({
      run,
      completion: completion as Deferred<unknown>,
    });
    this.advance();
    return completion.promise;
  }

  private async acquireRegular(): Promise<void> {
    if (!this.exclusiveActive && this.exclusiveWaiters.length === 0) {
      this.activeRegular += 1;
      return;
    }
    const waiter = deferred<void>();
    this.regularWaiters.push(waiter);
    await waiter.promise;
  }

  private releaseRegular(): void {
    this.activeRegular -= 1;
    if (this.activeRegular < 0) {
      throw new Error('Table operation gate released an inactive regular lease.');
    }
    this.advance();
  }

  private advance(): void {
    if (this.exclusiveActive || this.activeRegular > 0) {
      return;
    }

    const exclusive = this.exclusiveWaiters.shift();
    if (exclusive) {
      this.exclusiveActive = true;
      void Promise.resolve()
        .then(exclusive.run)
        .then(value => exclusive.completion.resolve(value))
        .catch(error => exclusive.completion.reject(error))
        .finally(() => {
          this.exclusiveActive = false;
          this.advance();
        });
      return;
    }

    if (this.regularWaiters.length > 0) {
      const waiters = this.regularWaiters.splice(0);
      this.activeRegular += waiters.length;
      for (const waiter of waiters) {
        waiter.resolve();
      }
    }
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

export type VectorMaintenanceCoordinatorOptions = {
  enabled: boolean;
  mutationCheckEvery: number;
  delayMs: number;
  periodicMs: number;
  retryMs: number;
  runCheck: (triggers: VectorMaintenanceTrigger[]) => Promise<void>;
  onError?: (error: unknown, triggers: VectorMaintenanceTrigger[]) => void;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

/**
 * Coalesces startup, mutation-volume, periodic, and retry checks. The callback
 * owns the exclusive table gate; this class only decides when one check runs.
 */
export class VectorMaintenanceCoordinator {
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private mutationCount = 0;
  private firstRequestedAt = 0;
  private notBeforeAt = 0;
  private readonly pendingTriggers = new Set<VectorMaintenanceTrigger>();
  private timer?: TimerHandle;
  private periodicTimer?: IntervalHandle;
  private running?: Promise<void>;
  private stopping = false;

  constructor(private readonly options: VectorMaintenanceCoordinatorOptions) {
    this.now = options.now || Date.now;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
  }

  start(): void {
    if (!this.options.enabled || this.stopping || this.periodicTimer) {
      return;
    }
    this.periodicTimer = this.setIntervalFn(() => {
      this.request('periodic');
    }, this.options.periodicMs);
    this.periodicTimer.unref?.();
  }

  recordMutation(): void {
    if (!this.options.enabled || this.stopping) {
      return;
    }
    this.mutationCount += 1;
    if (this.mutationCount >= this.options.mutationCheckEvery) {
      this.mutationCount = 0;
      this.request('mutation-threshold');
    }
  }

  request(trigger: VectorMaintenanceTrigger): void {
    if (!this.options.enabled || this.stopping) {
      return;
    }
    if (this.running) {
      return;
    }
    this.pendingTriggers.add(trigger);
    if (this.firstRequestedAt === 0) {
      this.firstRequestedAt = this.now();
      this.schedulePending();
    }
  }

  runStartupCheck(): Promise<void> {
    if (!this.options.enabled || this.stopping) {
      return Promise.resolve();
    }
    if (this.running) {
      return this.running;
    }
    this.pendingTriggers.add('startup');
    return this.launch();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    if (this.periodicTimer) {
      this.clearIntervalFn(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    this.pendingTriggers.clear();
    this.firstRequestedAt = 0;
    this.notBeforeAt = 0;
    await this.running;
  }

  private schedulePending(): void {
    if (this.running || this.stopping || this.firstRequestedAt === 0 || this.timer) {
      return;
    }
    const now = this.now();
    const dueAt = Math.max(this.firstRequestedAt + this.options.delayMs, this.notBeforeAt);
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      void this.launch();
    }, Math.max(0, dueAt - now));
    this.timer.unref?.();
  }

  private launch(): Promise<void> {
    if (this.stopping || !this.options.enabled) {
      return Promise.resolve();
    }
    if (this.running) {
      return this.running;
    }
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    const triggers = [...this.pendingTriggers];
    this.pendingTriggers.clear();
    this.firstRequestedAt = 0;
    this.notBeforeAt = 0;
    if (triggers.length === 0) {
      return Promise.resolve();
    }

    const running = this.options.runCheck(triggers)
      .catch(error => {
        this.options.onError?.(error, triggers);
        if (!this.stopping) {
          this.pendingTriggers.add('retry');
          this.firstRequestedAt = this.now();
          this.notBeforeAt = this.firstRequestedAt + this.options.retryMs;
        }
      })
      .finally(() => {
        if (this.running === running) {
          this.running = undefined;
        }
        if (!this.stopping && this.pendingTriggers.size > 0) {
          if (this.firstRequestedAt === 0) {
            this.firstRequestedAt = this.now();
          }
          this.schedulePending();
        }
      });
    this.running = running;
    return running;
  }
}
