import { ChildProcess, fork } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { logger } from './common';
import { createMainManagementToolServiceHandler, mainManagementToolServiceDescriptor } from './mainManagementToolService';
import { createMcpExternalServiceHandler, mcpExternalServiceDescriptor } from './mcpExternalService';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { createFileDeliveryServiceHandler, fileDeliveryServiceDescriptor } from './fileDeliveryService';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcClient, RpcError, RpcServiceRegistry } from './rpc';
import { SessionWorkerIdentity, sessionWorkerControlServiceDescriptor } from './sessionWorkerControlService';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerOwnershipRecord, SessionWorkerStore } from './sessionWorkerStore';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { createVectorFacadeProxyHandler } from './vectorFacadeProxy';
import { vectorServiceDescriptor } from './vectorServiceDescriptor';
import { createSessionWorkerPublicationServiceHandler, sessionWorkerPublicationServiceDescriptor,
  SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import { createSessionTurnDeliveryServiceHandler, sessionTurnDeliveryServiceDescriptor,
  type ExactFinalSourceContextResolver } from './sessionTurnDelivery';

export type SessionWorkerSupervisorOptions = {
  store: SessionWorkerStore;
  workerScriptPath?: string;
  workerEnv?: Record<string, string>;
  idleMs: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  shouldRestart?: (sessionId: string) => boolean | Promise<boolean>;
  readProcessIdentity?: (pid: number) => string | null;
  projectionRegistry?: SessionWorkerProjectionRegistry;
  resolveExactFinalSourceContext?: ExactFinalSourceContextResolver;
};

type ProvisionalChild = {
  sessionId: string; generation: number; incarnationId: string; child: ChildProcess;
  exitPromise: Promise<void>; resolveExit: () => void;
  exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  disconnected: boolean; error?: Error; entry?: WorkerEntry;
  reverseServer?: ProcessRpcServer;
};

type WorkerEntry = {
  sessionId: string; generation: number; incarnationId: string; processIdentity: string;
  child: ChildProcess; transport: ProcessRpcClientTransport;
  reverseServer: ProcessRpcServer;
  client?: RpcClient<typeof sessionWorkerControlServiceDescriptor>;
  ready: boolean; activeCalls: number; intentionalStop: boolean; idleTimer?: NodeJS.Timeout;
  exitPromise: Promise<void>; resolveExit: () => void; exitRecordError?: unknown;
};

export type SessionWorkerSupervisorStatus = {
  sessionId: string; generation: number; incarnationId: string; ready: boolean; pid?: number; activeCalls: number;
};

export class SessionWorkerLifecycleError extends Error {
  constructor(message: string, readonly errors: unknown[]) {
    super(message);
    this.name = 'SessionWorkerLifecycleError';
  }
}

export class SessionWorkerSupervisor {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly starts = new Map<string, Promise<SessionWorkerSupervisorStatus>>();
  private readonly provisionalChildren = new Map<string, ProvisionalChild>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly restartDelays = new Map<string, number>();
  private readonly lifecycleFailures = new Map<string, unknown>();
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  readonly projectionRegistry: SessionWorkerProjectionRegistry;
  private shuttingDown = false;
  private reconciled = false;

  constructor(private readonly options: SessionWorkerSupervisorOptions) {
    if (!Number.isFinite(options.idleMs) || options.idleMs < 1) throw new RpcError('SESSION_WORKER_INVALID_IDLE', 'Session worker idle timeout must be positive.');
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? 250;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? 5_000;
    this.projectionRegistry = options.projectionRegistry || new SessionWorkerProjectionRegistry();
  }

  async reconcileStartupOwnerships(timeoutMs = 5_000): Promise<number> {
    if (this.entries.size || this.starts.size || this.provisionalChildren.size) {
      throw new RpcError('SESSION_WORKER_RECOVERY_ACTIVE', 'Cannot reconcile ownership after workers start.');
    }
    this.reconciled = false;
    const records = this.options.store.listFencedOwnerships();
    const failures: unknown[] = [];
    let recovered = 0;
    for (const record of records) {
      try { await this.reconcileOwnership(record, timeoutMs); recovered += 1; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new SessionWorkerLifecycleError('Session worker startup reconciliation failed; durable fences were retained.', failures);
    this.reconciled = true;
    return recovered;
  }

  getStatus(sessionId: string): SessionWorkerSupervisorStatus | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? { sessionId, generation: entry.generation, incarnationId: entry.incarnationId,
      ready: entry.ready, pid: entry.child.pid, activeCalls: entry.activeCalls } : undefined;
  }
  listStatuses(): SessionWorkerSupervisorStatus[] { return [...this.entries.keys()].sort().map(id => this.getStatus(id)!); }

  async ensureWorker(sessionId: string): Promise<SessionWorkerSupervisorStatus> {
    if (!this.reconciled) throw new RpcError('SESSION_WORKER_RECOVERY_REQUIRED', 'Session worker ownership must be reconciled before spawning.', true);
    if (this.shuttingDown) throw new RpcError('SESSION_WORKER_SHUTTING_DOWN', 'Session worker supervisor is shutting down.', true);
    if (this.lifecycleFailures.has(sessionId)) {
      throw new SessionWorkerLifecycleError(`Session worker ${sessionId} retains an unresolved lifecycle fence.`, [this.lifecycleFailures.get(sessionId)]);
    }
    const pending = this.starts.get(sessionId); if (pending) return pending;
    const existing = this.entries.get(sessionId);
    if (existing?.ready && existing.client) { this.touchEntry(existing); return this.getStatus(sessionId)!; }
    if (existing) throw new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} generation ${existing.generation} has not exited.`, true);
    const start = this.startWorker(sessionId).finally(() => { if (this.starts.get(sessionId) === start) this.starts.delete(sessionId); });
    this.starts.set(sessionId, start);
    return start;
  }

  async callStatus(sessionId: string): Promise<SessionWorkerIdentity & { active: boolean }> {
    const status = await this.ensureWorker(sessionId);
    const entry = this.entries.get(sessionId);
    if (!entry?.client || entry.generation !== status.generation) throw new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} is unavailable.`, true);
    entry.activeCalls += 1; this.clearIdleTimer(entry);
    try { return await entry.client.call('status', {}); }
    finally { entry.activeCalls -= 1; if (this.entries.get(sessionId) === entry && entry.ready) this.touchEntry(entry); }
  }

  assertActivatedOwnership(sessionId: string, expected: Pick<SessionWorkerOwnershipRecord, 'generation' | 'incarnationId'>): void {
    const durable = this.options.store.findOwnership(sessionId);
    const entry = this.entries.get(sessionId);
    if (!durable || durable.state !== 'ready' || !durable.incarnationId
      || durable.generation !== expected.generation || durable.incarnationId !== expected.incarnationId
      || !entry?.ready || !entry.client || entry.generation !== expected.generation || entry.incarnationId !== expected.incarnationId) {
      throw new RpcError('SESSION_WORKER_INGRESS_UNAVAILABLE', `Session worker ${sessionId} is not the exact activated owner.`, true);
    }
  }

  async runPendingActivated(
    sessionId: string,
    expected: Pick<SessionWorkerOwnershipRecord, 'generation' | 'incarnationId'>,
    limit = 4096,
  ) {
    this.assertActivatedOwnership(sessionId, expected);
    const entry = this.entries.get(sessionId)!;
    entry.activeCalls += 1; this.clearIdleTimer(entry);
    try {
      const runtime = new RpcClient(sessionWorkerRuntimeServiceDescriptor, entry.transport);
      return await runtime.call('runPending', { limit });
    } finally {
      entry.activeCalls -= 1;
      if (this.entries.get(sessionId) === entry && entry.ready) this.touchEntry(entry);
    }
  }

  touch(sessionId: string): void { const entry = this.entries.get(sessionId); if (entry?.ready) this.touchEntry(entry); }

  async stopWorker(sessionId: string, timeoutMs = 10_000): Promise<boolean> {
    const failures: unknown[] = this.lifecycleFailures.has(sessionId) ? [this.lifecycleFailures.get(sessionId)] : [];
    const restartTimer = this.restartTimers.get(sessionId);
    if (restartTimer) { clearTimeout(restartTimer); this.restartTimers.delete(sessionId); }
    const pendingStart = this.starts.get(sessionId);
    if (pendingStart) { try { await pendingStart; } catch (error) { failures.push(error); } }
    const entry = this.entries.get(sessionId);
    if (!entry) {
      const provisional = this.provisionalChildren.get(sessionId);
      if (provisional) {
        try { await this.cleanupProvisionalChild(provisional, timeoutMs, 'shutdown-provisional-child'); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new SessionWorkerLifecycleError(`Session worker ${sessionId} startup failed during stop.`, failures);
      return !!provisional;
    }
    entry.intentionalStop = true; entry.ready = false; entry.client = undefined; this.clearIdleTimer(entry);
    try { this.options.store.markDraining(sessionId, entry.generation, entry.incarnationId); }
    catch (error) { failures.push(error); }

    const phaseMs = Math.max(1, Math.floor(timeoutMs / 4));
    try { await entry.transport.drain(phaseMs); }
    catch (error) { logger.warn({ err: error, sessionId, pid: entry.child.pid }, 'Session worker RPC drain failed; continuing bounded termination'); }
    try { await entry.reverseServer.drain(phaseMs); }
    catch (error) { logger.warn({ err: error, sessionId, pid: entry.child.pid }, 'Session worker reverse RPC drain failed; continuing bounded termination'); }
    entry.reverseServer.close();
    entry.transport.close();
    let exited = await this.waitForChildExit(entry.child, phaseMs);
    if (!exited) { this.signalChild(entry.child, 'SIGTERM'); exited = await this.waitForChildExit(entry.child, phaseMs); }
    if (!exited) { this.signalChild(entry.child, 'SIGKILL'); exited = await this.waitForChildExit(entry.child, phaseMs); }
    if (!exited) failures.push(new RpcError('SESSION_WORKER_EXIT_UNCONFIRMED', `Session worker ${entry.child.pid ?? 'unknown'} did not confirm exit.`));
    else { await entry.exitPromise; if (entry.exitRecordError) failures.push(entry.exitRecordError); }
    if (failures.length) throw new SessionWorkerLifecycleError(`Session worker ${sessionId} stopped with lifecycle persistence failures.`, failures);
    return true;
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    this.shuttingDown = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer); this.restartTimers.clear();
    const failures: unknown[] = [];
    const sessionIds = [...new Set([
      ...this.entries.keys(), ...this.starts.keys(), ...this.provisionalChildren.keys(), ...this.lifecycleFailures.keys(),
    ])];
    const stopBudget = Math.max(1, deadline - Date.now());
    const results = await Promise.allSettled(sessionIds.map(id => this.stopWorker(id, stopBudget)));
    failures.push(...results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason));
    if (failures.length) throw new SessionWorkerLifecycleError('Session worker shutdown completed with lifecycle failures.', failures);
  }

  private async startWorker(sessionId: string): Promise<SessionWorkerSupervisorStatus> {
    const incarnationId = crypto.randomUUID();
    const ownership = this.options.store.beginGeneration(sessionId, incarnationId);
    const generation = ownership.generation;
    const publicationIdentity = { sessionId, generation, incarnationId };
    this.projectionRegistry.establish(publicationIdentity);
    let child: ChildProcess;
    try {
      child = fork(this.options.workerScriptPath || path.join(__dirname, 'sessionWorker.js'), [], {
        env: { ...process.env, ...this.options.workerEnv,
          FOXWARM_SESSION_WORKER_SESSION_ID: sessionId,
          FOXWARM_SESSION_WORKER_GENERATION: String(generation),
          FOXWARM_SESSION_WORKER_INCARNATION_ID: incarnationId,
          FOXWARM_SESSION_WORKER_STORE_PATH: this.options.store.filePath },
        serialization: 'advanced',
      });
    } catch (error) {
      this.options.store.clearUnregisteredCandidate(sessionId, generation, incarnationId, `spawn-failed:${(error as any)?.message || error}`);
      throw error;
    }
    // From this point the exact ChildProcess is provisionally owned before any
    // identity read or transport construction can throw.
    const provisional = this.trackProvisionalChild(sessionId, generation, incarnationId, child);
    let reverseServer: ProcessRpcServer | undefined;
    let processIdentity: string;
    let transport: ProcessRpcClientTransport;
    try {
      const reverseRegistry = new RpcServiceRegistry();
      reverseRegistry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({ expectedSourceSessionId: sessionId }));
      reverseRegistry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: sessionId }));
      reverseRegistry.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: sessionId }));
      reverseRegistry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({
        expectedSourceSessionId: sessionId,
        resolveExactSourceContext: this.options.resolveExactFinalSourceContext,
      }));
      reverseRegistry.register(sessionWorkerPublicationServiceDescriptor, createSessionWorkerPublicationServiceHandler({
        expected: publicationIdentity, registry: this.projectionRegistry,
      }));
      reverseRegistry.register(mcpExternalServiceDescriptor, createMcpExternalServiceHandler({ expectedSourceSessionId: sessionId }));
      reverseRegistry.register(vectorServiceDescriptor, createVectorFacadeProxyHandler());
      reverseServer = new ProcessRpcServer(reverseRegistry, {
        generation, peer: child, direction: 'reverse', exitOnDisconnect: false,
      });
      provisional.reverseServer = reverseServer;
      reverseServer.start();
      const identity = this.readProcessIdentity(child.pid!);
      if (!identity) throw new RpcError('SESSION_WORKER_PROCESS_IDENTITY_UNAVAILABLE', `Session worker ${sessionId} has no process identity.`, true);
      processIdentity = identity;
      transport = new ProcessRpcClientTransport(child, { generation });
    } catch (error) {
      reverseServer?.close();
      try { await this.cleanupProvisionalChild(provisional, 2_000, 'post-fork-startup-failure'); }
      catch (cleanupError) {
        throw new SessionWorkerLifecycleError(`Session worker ${sessionId} post-fork cleanup failed.`, [error, cleanupError]);
      }
      throw error;
    }
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
    const entry: WorkerEntry = { sessionId, generation, incarnationId, processIdentity, child, transport,
      reverseServer: reverseServer!, ready: false, activeCalls: 0, intentionalStop: false, exitPromise, resolveExit };
    this.entries.set(sessionId, entry);
    provisional.entry = entry;
    this.provisionalChildren.delete(sessionId);
    if (provisional.exitInfo) {
      void this.handleExit(entry, provisional.exitInfo.code, provisional.exitInfo.signal);
    } else if (provisional.disconnected) {
      this.handleDisconnect(entry);
    }
    try {
      if (provisional.exitInfo) throw new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} exited during spawn.`, true);
      if (provisional.disconnected) throw new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} disconnected during spawn.`, true);
      if (provisional.error) throw provisional.error;
      await transport.waitUntilReady();
      const client = new RpcClient(sessionWorkerControlServiceDescriptor, transport);
      const candidate = await client.call('status', {});
      if (candidate.active || candidate.sessionId !== sessionId || candidate.generation !== generation
        || candidate.incarnationId !== incarnationId || candidate.pid !== child.pid || candidate.processIdentity !== processIdentity) {
        throw new RpcError('SESSION_WORKER_IDENTITY_MISMATCH', `Session worker ${sessionId} candidate identity does not match.`);
      }
      this.options.store.registerCandidate(sessionId, generation, incarnationId, child.pid!, processIdentity);
      this.options.store.activateCandidate(sessionId, generation, incarnationId, child.pid!, processIdentity);
      await client.call('activate', {});
      const active = await client.call('status', {});
      if (!active.active) throw new RpcError('SESSION_WORKER_NOT_ACTIVATED', `Session worker ${sessionId} did not activate.`, true);
      entry.client = client; entry.ready = true;
      this.restartDelays.set(sessionId, this.restartBaseDelayMs); this.touchEntry(entry);
      logger.info({ sessionId, generation, incarnationId, pid: child.pid }, 'Session worker ready');
      return this.getStatus(sessionId)!;
    } catch (error) {
      entry.intentionalStop = true; entry.client = undefined; transport.close();
      reverseServer.close();
      await this.terminateChildAndConfirm(entry, 2_000); await entry.exitPromise;
      if (entry.exitRecordError) throw new SessionWorkerLifecycleError(`Session worker ${sessionId} startup cleanup failed.`, [error, entry.exitRecordError]);
      throw error instanceof RpcError ? error : new RpcError('SESSION_WORKER_UNAVAILABLE', `Session worker ${sessionId} failed to start: ${(error as any)?.message || error}`, true);
    }
  }

  private handleDisconnect(entry: WorkerEntry): void {
    if (this.entries.get(entry.sessionId) !== entry) return;
    entry.ready = false; entry.client = undefined; entry.transport.close(); this.clearIdleTimer(entry);
    entry.reverseServer.close();
    this.projectionRegistry.markStale(entry);
    if (!entry.intentionalStop && !this.shuttingDown) logger.warn({ sessionId: entry.sessionId, generation: entry.generation, pid: entry.child.pid }, 'Session worker IPC disconnected; waiting for process exit');
  }

  private async handleExit(entry: WorkerEntry, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.entries.get(entry.sessionId) !== entry) { entry.resolveExit(); return; }
    entry.ready = false; entry.client = undefined; entry.transport.close(); this.clearIdleTimer(entry); this.entries.delete(entry.sessionId);
    entry.reverseServer.close();
    this.projectionRegistry.markStale(entry);
    const reason = `${entry.intentionalStop ? 'stopped' : 'unexpected'}:${code ?? signal ?? 'unknown'}`;
    try { this.options.store.markExitObserved(entry.sessionId, entry.generation, entry.incarnationId, reason); }
    catch (error) {
      entry.exitRecordError = error;
      this.lifecycleFailures.set(entry.sessionId, error);
      logger.error({ err: error, sessionId: entry.sessionId, generation: entry.generation }, 'Failed to record session worker exit; fence retained');
    }
    finally { entry.resolveExit(); }
    if (!entry.intentionalStop && !this.shuttingDown && !entry.exitRecordError) {
      logger.error({ sessionId: entry.sessionId, generation: entry.generation, pid: entry.child.pid, code, signal }, 'Session worker exited unexpectedly');
      try { if (await this.options.shouldRestart?.(entry.sessionId)) this.scheduleRestart(entry.sessionId); }
      catch (error) { logger.error({ err: error, sessionId: entry.sessionId }, 'Session worker restart decision failed'); }
    }
  }

  private trackProvisionalChild(
    sessionId: string,
    generation: number,
    incarnationId: string,
    child: ChildProcess,
  ): ProvisionalChild {
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
    const provisional: ProvisionalChild = {
      sessionId, generation, incarnationId, child, disconnected: false,
      exitPromise, resolveExit,
    };
    this.provisionalChildren.set(sessionId, provisional);
    child.once('error', error => { provisional.error = error; });
    child.once('disconnect', () => {
      provisional.disconnected = true;
      if (provisional.entry) this.handleDisconnect(provisional.entry);
    });
    child.once('exit', (code, signal) => {
      provisional.exitInfo = { code, signal };
      provisional.resolveExit();
      if (provisional.entry) void this.handleExit(provisional.entry, code, signal);
    });
    return provisional;
  }

  private async cleanupProvisionalChild(provisional: ProvisionalChild, timeoutMs: number, reason: string): Promise<void> {
    const phaseMs = Math.max(1, Math.floor(timeoutMs / 2));
    this.signalChild(provisional.child, 'SIGTERM');
    let exited = await this.waitForProvisionalExit(provisional, phaseMs);
    if (!exited) {
      this.signalChild(provisional.child, 'SIGKILL');
      exited = await this.waitForProvisionalExit(provisional, phaseMs);
    }
    if (!exited) {
      const error = new RpcError(
        'SESSION_WORKER_EXIT_UNCONFIRMED',
        `Provisional session worker ${provisional.child.pid ?? 'unknown'} did not confirm exit; candidate fence retained.`,
      );
      this.lifecycleFailures.set(provisional.sessionId, error);
      throw error;
    }
    this.provisionalChildren.delete(provisional.sessionId);
    provisional.reverseServer?.close();
    try {
      this.options.store.clearUnregisteredCandidate(
        provisional.sessionId,
        provisional.generation,
        provisional.incarnationId,
        reason,
      );
    } catch (error) {
      this.lifecycleFailures.set(provisional.sessionId, error);
      throw error;
    }
  }

  private async waitForProvisionalExit(provisional: ProvisionalChild, timeoutMs: number): Promise<boolean> {
    if (provisional.exitInfo) return true;
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      provisional.exitPromise.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  private async reconcileOwnership(record: SessionWorkerOwnershipRecord, timeoutMs: number): Promise<void> {
    if (record.state === 'candidate' && !record.workerPid && !record.processIdentity && !record.activatedAt && record.incarnationId) {
      this.options.store.clearUnregisteredCandidate(record.sessionId, record.generation, record.incarnationId, 'startup-abandoned-inert-candidate');
      return;
    }
    if (!record.incarnationId || !record.workerPid || !record.processIdentity) {
      throw new RpcError('SESSION_WORKER_RECOVERY_IDENTITY_MISSING', `Cannot prove old worker identity for ${record.sessionId}; fence retained.`);
    }
    const actual = this.readProcessIdentity(record.workerPid);
    if (actual === record.processIdentity) await this.terminateExactProcess(record.workerPid, record.processIdentity, timeoutMs);
    // null means exited; a different identity proves PID reuse and must not be signalled.
    this.options.store.markExitObserved(record.sessionId, record.generation, record.incarnationId,
      actual && actual !== record.processIdentity ? 'startup-pid-reused' : 'startup-old-incarnation-exited');
  }

  private async terminateExactProcess(pid: number, identity: string, timeoutMs: number): Promise<void> {
    const phaseMs = Math.max(1, Math.floor(timeoutMs / 2));
    this.signalExactPid(pid, identity, 'SIGTERM');
    if (await this.waitForIdentityGone(pid, identity, phaseMs)) return;
    this.signalExactPid(pid, identity, 'SIGKILL');
    if (!await this.waitForIdentityGone(pid, identity, phaseMs)) {
      throw new RpcError('SESSION_WORKER_EXIT_UNCONFIRMED', `Old session worker PID ${pid} did not confirm exit; fence retained.`);
    }
  }
  private signalExactPid(pid: number, identity: string, signal: NodeJS.Signals): void {
    if (this.readProcessIdentity(pid) !== identity) return;
    try { process.kill(pid, signal); } catch (error: any) { if (error?.code !== 'ESRCH') throw error; }
  }
  private async waitForIdentityGone(pid: number, identity: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (this.readProcessIdentity(pid) !== identity) return true; await new Promise(resolve => setTimeout(resolve, 20)); }
    return this.readProcessIdentity(pid) !== identity;
  }

  private readProcessIdentity(pid: number): string | null {
    return (this.options.readProcessIdentity || readSessionWorkerProcessIdentity)(pid);
  }

  private touchEntry(entry: WorkerEntry): void {
    if (!entry.ready || this.entries.get(entry.sessionId) !== entry) return;
    this.options.store.touch(entry.sessionId, entry.generation, entry.incarnationId);
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.activeCalls > 0 || !entry.ready || this.entries.get(entry.sessionId) !== entry) { this.touchEntry(entry); return; }
      void this.stopWorker(entry.sessionId).catch(error => logger.error({ err: error, sessionId: entry.sessionId }, 'Failed to release idle session worker'));
    }, this.options.idleMs); entry.idleTimer.unref?.();
  }
  private clearIdleTimer(entry: WorkerEntry): void { if (entry.idleTimer) clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
  private scheduleRestart(sessionId: string): void {
    if (this.shuttingDown || this.restartTimers.has(sessionId)) return;
    const delay = this.restartDelays.get(sessionId) ?? this.restartBaseDelayMs;
    this.restartDelays.set(sessionId, Math.min(this.restartMaxDelayMs, Math.max(this.restartBaseDelayMs, delay * 2)));
    const timer = setTimeout(() => { this.restartTimers.delete(sessionId); void this.ensureWorker(sessionId).catch(error => { logger.error({ err: error, sessionId }, 'Session worker restart failed'); this.scheduleRestart(sessionId); }); }, delay);
    timer.unref?.(); this.restartTimers.set(sessionId, timer);
  }
  private async terminateChildAndConfirm(entry: WorkerEntry, timeoutMs: number): Promise<void> {
    const phaseMs = Math.max(1, Math.floor(timeoutMs / 2));
    this.signalChild(entry.child, 'SIGTERM'); let exited = await this.waitForChildExit(entry.child, phaseMs);
    if (!exited) { this.signalChild(entry.child, 'SIGKILL'); exited = await this.waitForChildExit(entry.child, phaseMs); }
    if (!exited) throw new RpcError('SESSION_WORKER_EXIT_UNCONFIRMED', `Session worker ${entry.child.pid ?? 'unknown'} did not confirm exit.`);
  }
  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let timer: NodeJS.Timeout | undefined; let onExit: (() => void) | undefined;
    return new Promise(resolve => { onExit = () => { if (timer) clearTimeout(timer); resolve(true); }; child.once('exit', onExit);
      timer = setTimeout(() => { if (onExit) child.off('exit', onExit); resolve(false); }, timeoutMs); timer.unref?.(); });
  }
  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void { try { child.kill(signal); } catch (error) { logger.warn({ err: error, pid: child.pid, signal }, 'Failed to signal session worker'); } }
}
