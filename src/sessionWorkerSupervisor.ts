import { ChildProcess, fork } from 'node:child_process';
import path from 'node:path';
import { logger } from './common';
import { ProcessRpcClientTransport, RpcClient, RpcError } from './rpc';
import {
  SessionWorkerIdentity,
  sessionWorkerControlServiceDescriptor,
} from './sessionWorkerControlService';
import { SessionWorkerStore } from './sessionWorkerStore';

export type SessionWorkerSupervisorOptions = {
  store: SessionWorkerStore;
  workerScriptPath?: string;
  idleMs: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  shouldRestart?: (sessionId: string) => boolean | Promise<boolean>;
};

type WorkerEntry = {
  sessionId: string;
  generation: number;
  child: ChildProcess;
  transport: ProcessRpcClientTransport;
  client?: RpcClient<typeof sessionWorkerControlServiceDescriptor>;
  ready: boolean;
  activeCalls: number;
  intentionalStop: boolean;
  idleTimer?: NodeJS.Timeout;
  exitPromise: Promise<void>;
  resolveExit: () => void;
};

export type SessionWorkerSupervisorStatus = {
  sessionId: string;
  generation: number;
  ready: boolean;
  pid?: number;
  activeCalls: number;
};

export class SessionWorkerSupervisor {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly starts = new Map<string, Promise<SessionWorkerSupervisorStatus>>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly restartDelays = new Map<string, number>();
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private shuttingDown = false;

  constructor(private readonly options: SessionWorkerSupervisorOptions) {
    if (!Number.isFinite(options.idleMs) || options.idleMs < 1) {
      throw new RpcError('SESSION_WORKER_INVALID_IDLE', 'Session worker idle timeout must be positive.');
    }
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? 250;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? 5_000;
  }

  recoverStartupOwnerships(): number {
    return this.options.store.recoverOrphanedOwnerships();
  }

  getStatus(sessionId: string): SessionWorkerSupervisorStatus | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    return {
      sessionId,
      generation: entry.generation,
      ready: entry.ready,
      pid: entry.child.pid,
      activeCalls: entry.activeCalls,
    };
  }

  listStatuses(): SessionWorkerSupervisorStatus[] {
    return [...this.entries.keys()].sort().map(sessionId => this.getStatus(sessionId)!);
  }

  async ensureWorker(sessionId: string): Promise<SessionWorkerSupervisorStatus> {
    if (this.shuttingDown) {
      throw new RpcError('SESSION_WORKER_SHUTTING_DOWN', 'Session worker supervisor is shutting down.', true);
    }
    const pending = this.starts.get(sessionId);
    if (pending) return pending;
    const existing = this.entries.get(sessionId);
    if (existing?.ready && existing.client) {
      this.touchEntry(existing);
      return this.getStatus(sessionId)!;
    }
    if (existing) {
      throw new RpcError(
        'SESSION_WORKER_UNAVAILABLE',
        `Session worker ${sessionId} generation ${existing.generation} has not exited yet.`,
        true,
      );
    }
    const start = this.startWorker(sessionId).finally(() => {
      if (this.starts.get(sessionId) === start) this.starts.delete(sessionId);
    });
    this.starts.set(sessionId, start);
    return start;
  }

  async callStatus(sessionId: string): Promise<SessionWorkerIdentity & { ready: true }> {
    const status = await this.ensureWorker(sessionId);
    const entry = this.entries.get(sessionId);
    if (!entry?.client || entry.generation !== status.generation) {
      throw new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} is unavailable.`, true);
    }
    entry.activeCalls += 1;
    this.clearIdleTimer(entry);
    try {
      return await entry.client.call('status', {});
    } finally {
      entry.activeCalls -= 1;
      if (this.entries.get(sessionId) === entry && entry.ready) this.touchEntry(entry);
    }
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry?.ready) return;
    this.touchEntry(entry);
  }

  async stopWorker(sessionId: string, timeoutMs = 10_000): Promise<boolean> {
    const restartTimer = this.restartTimers.get(sessionId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.restartTimers.delete(sessionId);
    }
    const pendingStart = this.starts.get(sessionId);
    if (pendingStart) {
      try { await pendingStart; } catch {}
    }
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.intentionalStop = true;
    entry.ready = false;
    entry.client = undefined;
    this.clearIdleTimer(entry);
    try {
      this.options.store.markDraining(sessionId, entry.generation);
    } catch (error) {
      const ownership = this.options.store.getOwnership(sessionId);
      if (ownership.generation !== entry.generation || ownership.state !== 'draining') throw error;
    }

    const phaseMs = Math.max(1, Math.floor(timeoutMs / 4));
    try {
      await entry.transport.drain(phaseMs);
    } catch (error) {
      logger.warn({ err: error, sessionId, pid: entry.child.pid }, 'Session worker RPC drain failed; continuing bounded termination');
    }
    entry.transport.close();

    let exited = await this.waitForChildExit(entry.child, phaseMs);
    if (!exited) {
      this.signalChild(entry.child, 'SIGTERM');
      exited = await this.waitForChildExit(entry.child, phaseMs);
    }
    if (!exited) {
      this.signalChild(entry.child, 'SIGKILL');
      exited = await this.waitForChildExit(entry.child, phaseMs);
    }
    if (!exited) {
      throw new RpcError(
        'SESSION_WORKER_EXIT_UNCONFIRMED',
        `Session worker ${entry.child.pid ?? 'unknown'} did not confirm exit after drain, SIGTERM, and SIGKILL.`,
      );
    }
    await entry.exitPromise;
    return true;
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    const sessionIds = [...new Set([...this.entries.keys(), ...this.starts.keys()])];
    const failures: unknown[] = [];
    for (const sessionId of sessionIds) {
      try { await this.stopWorker(sessionId, timeoutMs); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }

  private async startWorker(sessionId: string): Promise<SessionWorkerSupervisorStatus> {
    const ownership = this.options.store.beginGeneration(sessionId);
    const generation = ownership.generation;
    let child: ChildProcess;
    try {
      child = fork(this.options.workerScriptPath || path.join(__dirname, 'sessionWorker.js'), [], {
        env: {
          ...process.env,
          FOXWARM_SESSION_WORKER_SESSION_ID: sessionId,
          FOXWARM_SESSION_WORKER_GENERATION: String(generation),
        },
        serialization: 'advanced',
      });
    } catch (error) {
      this.options.store.markExitObserved(sessionId, generation, `spawn-failed:${(error as any)?.message || error}`);
      throw error;
    }
    const transport = new ProcessRpcClientTransport(child, { generation });
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
    const entry: WorkerEntry = {
      sessionId,
      generation,
      child,
      transport,
      ready: false,
      activeCalls: 0,
      intentionalStop: false,
      exitPromise,
      resolveExit,
    };
    this.entries.set(sessionId, entry);
    child.once('disconnect', () => this.handleDisconnect(entry));
    child.once('exit', (code, signal) => { void this.handleExit(entry, code, signal); });

    try {
      await transport.waitUntilReady();
      if (child.exitCode !== null || child.signalCode !== null || this.entries.get(sessionId) !== entry) {
        throw new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} exited during startup.`, true);
      }
      entry.client = new RpcClient(sessionWorkerControlServiceDescriptor, transport);
      const identity = await entry.client.call('status', {});
      if (identity.sessionId !== sessionId || identity.generation !== generation || identity.pid !== child.pid) {
        throw new RpcError('SESSION_WORKER_IDENTITY_MISMATCH', `Session worker ${sessionId} reported the wrong identity.`);
      }
      this.options.store.markReady(sessionId, generation, child.pid!);
      entry.ready = true;
      this.restartDelays.set(sessionId, this.restartBaseDelayMs);
      this.touchEntry(entry);
      logger.info({ sessionId, generation, pid: child.pid }, 'Session worker ready');
      return this.getStatus(sessionId)!;
    } catch (error) {
      entry.intentionalStop = true;
      entry.client = undefined;
      transport.close();
      await this.terminateChildAndConfirm(entry, 2_000);
      await entry.exitPromise;
      throw error instanceof RpcError
        ? error
        : new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} failed to start: ${(error as any)?.message || error}`, true);
    }
  }

  private handleDisconnect(entry: WorkerEntry): void {
    if (this.entries.get(entry.sessionId) !== entry) return;
    entry.ready = false;
    entry.client = undefined;
    entry.transport.close();
    this.clearIdleTimer(entry);
    if (!entry.intentionalStop && !this.shuttingDown) {
      logger.warn({ sessionId: entry.sessionId, generation: entry.generation, pid: entry.child.pid }, 'Session worker IPC disconnected; waiting for process exit');
    }
  }

  private async handleExit(entry: WorkerEntry, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.entries.get(entry.sessionId) !== entry) {
      entry.resolveExit();
      return;
    }
    entry.ready = false;
    entry.client = undefined;
    entry.transport.close();
    this.clearIdleTimer(entry);
    this.entries.delete(entry.sessionId);
    const reason = entry.intentionalStop
      ? `stopped:${code ?? signal ?? 'unknown'}`
      : `unexpected:${code ?? signal ?? 'unknown'}`;
    let exitRecorded = false;
    try {
      this.options.store.markExitObserved(entry.sessionId, entry.generation, reason);
      exitRecorded = true;
    } catch (error) {
      logger.error({ err: error, sessionId: entry.sessionId, generation: entry.generation }, 'Failed to record session worker exit');
    } finally {
      entry.resolveExit();
    }
    if (!entry.intentionalStop && !this.shuttingDown && exitRecorded) {
      logger.error({ sessionId: entry.sessionId, generation: entry.generation, pid: entry.child.pid, code, signal }, 'Session worker exited unexpectedly');
      try {
        if (await this.options.shouldRestart?.(entry.sessionId)) this.scheduleRestart(entry.sessionId);
      } catch (error) {
        logger.error({ err: error, sessionId: entry.sessionId }, 'Session worker restart decision failed');
      }
    }
  }

  private touchEntry(entry: WorkerEntry): void {
    if (!entry.ready || this.entries.get(entry.sessionId) !== entry) return;
    this.options.store.touch(entry.sessionId, entry.generation);
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.activeCalls > 0 || !entry.ready || this.entries.get(entry.sessionId) !== entry) {
        this.touchEntry(entry);
        return;
      }
      void this.stopWorker(entry.sessionId).catch(error => {
        logger.error({ err: error, sessionId: entry.sessionId, generation: entry.generation }, 'Failed to release idle session worker');
      });
    }, this.options.idleMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: WorkerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private scheduleRestart(sessionId: string): void {
    if (this.shuttingDown || this.restartTimers.has(sessionId)) return;
    const delay = this.restartDelays.get(sessionId) ?? this.restartBaseDelayMs;
    this.restartDelays.set(sessionId, Math.min(this.restartMaxDelayMs, Math.max(this.restartBaseDelayMs, delay * 2)));
    const timer = setTimeout(() => {
      this.restartTimers.delete(sessionId);
      void this.ensureWorker(sessionId).catch(error => {
        logger.error({ err: error, sessionId }, 'Session worker restart failed');
        this.scheduleRestart(sessionId);
      });
    }, delay);
    timer.unref?.();
    this.restartTimers.set(sessionId, timer);
  }

  private async terminateChildAndConfirm(entry: WorkerEntry, timeoutMs: number): Promise<void> {
    const phaseMs = Math.max(1, Math.floor(timeoutMs / 3));
    let exited = await this.waitForChildExit(entry.child, phaseMs);
    if (!exited) { this.signalChild(entry.child, 'SIGTERM'); exited = await this.waitForChildExit(entry.child, phaseMs); }
    if (!exited) { this.signalChild(entry.child, 'SIGKILL'); exited = await this.waitForChildExit(entry.child, phaseMs); }
    if (!exited) throw new RpcError('SESSION_WORKER_EXIT_UNCONFIRMED', `Session worker ${entry.child.pid ?? 'unknown'} did not confirm exit.`);
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let timer: NodeJS.Timeout | undefined;
    let onExit: (() => void) | undefined;
    return new Promise<boolean>(resolve => {
      onExit = () => { if (timer) clearTimeout(timer); resolve(true); };
      child.once('exit', onExit);
      timer = setTimeout(() => { if (onExit) child.off('exit', onExit); resolve(false); }, timeoutMs);
      timer.unref?.();
    });
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    try { child.kill(signal); } catch (error) {
      logger.warn({ err: error, pid: child.pid, signal }, 'Failed to signal session worker');
    }
  }
}
