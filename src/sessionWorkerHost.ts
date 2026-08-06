import path from 'node:path';
import { logger } from './common';
import { STATE_DIR, getAgentDir } from './config';
import { createExecRuntime, type ExecRuntime } from './execManager';
import { initLlmRequestJournal } from './llmRequestJournal';
import type { CurrentSessionTurnEffects } from './llm';
import { RpcError } from './rpc';
import { initArchiveStore } from './session/archiveStore';
import { refreshSessionSnapshotForSession } from './session/agentMetadata';
import { getEffectiveCompactThresholdTokens, getUsageTotalTokens } from './session/history';
import { getManagedSessionState } from './session/managedState';
import { captureSessionSemanticState, restoreSessionSemanticState } from './session/metadataStore';
import { applyQueuedItemToWaitState, appendSessionMessagesForSession, startSessionWaitForSession, updateSessionBusyStateForSession } from './sessionManager';
import { clearActiveSessionRuntimeState, setActiveSessionRuntimeState } from './sessionRuntimeState';
import { LocalSessionTurnHost, SessionTurnRunner, type SessionTurnHost } from './sessionTurnRunner';
import {
  buildSessionWorkerProjection,
  SessionWorkerPersistence,
  type SessionWorkerPersistenceDependencies,
  type SessionWorkerProjection,
} from './sessionWorkerPersistence';
import type { SessionWorkerIdentity } from './sessionWorkerControlService';
import type { SessionWorkerStore } from './sessionWorkerStore';
import { isQueueItem, type Message, type QueueItem, type Session } from './types';
import { buildTimestampedSystemMessageParts } from './utils/systemMessageParts';

export type SessionWorkerHostDependencies = {
  persistence?: SessionWorkerPersistenceDependencies;
  initialize?: () => Promise<void>;
  createTurnHost?: (effects: CurrentSessionTurnEffects, session: Session) => SessionTurnHost;
  publishCommitted?: (projection: SessionWorkerProjection) => Promise<void>;
};

export class SessionWorkerHost {
  private readonly persistence: SessionWorkerPersistence;
  private loadPromise?: Promise<void>;
  private runTail: Promise<void> = Promise.resolve();
  private session?: Session;
  private runner?: SessionTurnRunner;
  private poison?: { original: unknown; resync: unknown };
  private publicationPoison?: unknown;

  constructor(
    private readonly identity: SessionWorkerIdentity,
    store: SessionWorkerStore,
    private readonly dependencies: SessionWorkerHostDependencies = {},
  ) {
    this.persistence = new SessionWorkerPersistence(store, dependencies.persistence);
  }

  async runPending(limit: number): Promise<SessionWorkerProjection> {
    const run = this.serialize(() => this.runPendingSerial(limit));
    return run;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.runTail.then(operation);
    this.runTail = run.then(() => {}, () => {});
    return run;
  }

  private async runPendingSerial(limit: number): Promise<SessionWorkerProjection> {
    await this.ensureLoaded();
    await this.ensureHealthy();
    const session = this.session!;
    try {
      this.assertSupportedQueue(session);
      const mailboxCursorBefore = session.lastAppliedMailboxId || 0;
      await this.persistence.applyAndPersistPendingPrefix(
        session,
        this.identity.generation,
        this.identity.incarnationId,
        limit,
        (owner, intents) => {
          if (intents.some(intent => isQueueItem(intent.payload) && intent.payload.type === 'compact-commit')) {
            throw new RpcError('SESSION_WORKER_QUEUE_UNSUPPORTED', 'Managed-session and compact-commit queues are not supported by the Session worker yet.', true);
          }
          for (const intent of intents) {
            if (intent.kind !== 'enqueue' || !isQueueItem(intent.payload)) {
              throw new RpcError('SESSION_WORKER_INVALID_QUEUE_ITEM', 'Session worker mailbox payload is not a current QueueItem.');
            }
            const transition = applyQueuedItemToWaitState(owner, structuredClone(intent.payload));
            if (transition.action === 'enqueue') owner.queue.push(...transition.items);
          }
        },
      );
      if ((session.lastAppliedMailboxId || 0) !== mailboxCursorBefore) await this.publishCurrent();
      await this.runner!.processSessionQueue(session.id);
    } catch (error) {
      await this.resyncAfterFailure(error);
      throw error;
    }
    return buildSessionWorkerProjection(session);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.load();
      this.loadPromise = attempt;
      try { await attempt; }
      catch (error) { if (this.loadPromise === attempt && !this.session) this.loadPromise = undefined; throw error; }
      return;
    }
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    if (this.dependencies.initialize) await this.dependencies.initialize();
    else await Promise.all([initArchiveStore(), initLlmRequestJournal()]);
    const session = await this.persistence.loadActivated(this.baseSession(), this.identity.generation, this.identity.incarnationId);
    this.session = session;
    const execRuntime = this.createExecRuntime(session);
    try { await execRuntime.initialize(); }
    catch (error) { throw new RpcError('SESSION_WORKER_INITIALIZATION_FAILED', `Session worker ExecRuntime initialization failed: ${(error as any)?.message || error}`, true); }
    const effects = this.createEffects(session, execRuntime);
    this.runner = new SessionTurnRunner((this.dependencies.createTurnHost || ((ownerEffects, owner) => new LocalSessionTurnHost(
      ownerEffects, owner, {
        refreshSessionSnapshot: async sessionId => {
        this.assertId(sessionId);
        await this.fenceMutation();
        const before = captureSessionSemanticState(owner);
        try {
          return await refreshSessionSnapshotForSession(owner, () => this.persistOwner());
        } catch (error) {
          if (!this.isResyncError(error)) restoreSessionSemanticState(owner, before);
          throw error;
        }
        },
        queueSessionSystemEvent: (sessionId, message, type = 'background') => {
          this.assertId(sessionId);
          return this.applyAndPersistQueueItem({ type, parts: buildTimestampedSystemMessageParts(message) });
        },
        applyCompletedCompactJob: async sessionId => { this.assertId(sessionId); throw this.compactionUnsupported(); },
        processSessionCompactionRequest: async sessionId => { this.assertId(sessionId); throw this.compactionUnsupported(); },
        checkAndCompactIfNeeded: async (sessionId, usage) => {
          this.assertId(sessionId);
          const total = getUsageTotalTokens(usage);
          if (total > 0 && total > getEffectiveCompactThresholdTokens(owner)) throw this.compactionUnsupported();
        },
      },
    )))(effects, session));
    await this.publishCurrent();
  }

  private createEffects(session: Session, execRuntime: ExecRuntime): CurrentSessionTurnEffects {
    const persist = () => this.persistOwner();
    const transactional = async (operation: () => Promise<void>): Promise<void> => {
      await this.fenceMutation();
      const before = captureSessionSemanticState(session);
      try { await operation(); }
      catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    };
    const appendMessages = (owner: Session, messages: Message[]) => transactional(async () => {
      this.assertOwner(owner);
      await appendSessionMessagesForSession(owner, messages, persist, () => {});
    });
    let activeAbort: AbortController | undefined;
    return {
      placement: 'session-worker',
      appendMessage: (owner, message) => appendMessages(owner, [message]),
      appendMessages,
      persistSession: owner => { this.assertOwner(owner); return persist(); },
      updateBusy: (owner, busy) => { this.assertOwner(owner); return transactional(() => updateSessionBusyStateForSession(
        owner, busy, persist, clearActiveSessionRuntimeState, undefined,
        error => String((error as any)?.code || '') !== 'SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED',
      )); },
      startWait: (owner, options) => {
        this.assertOwner(owner);
        let result: Awaited<ReturnType<typeof startSessionWaitForSession>>;
        return transactional(async () => { result = await startSessionWaitForSession(owner, options, persist); }).then(() => result!);
      },
      notifyHistoryUpdate: () => {},
      notifySessionEvent: () => {},
      setRuntimeState: setActiveSessionRuntimeState,
      clearRuntimeState: clearActiveSessionRuntimeState,
      registerAbortController: (sessionId, controller) => { this.assertId(sessionId); activeAbort = controller; },
      clearAbortController: (sessionId, controller) => { this.assertId(sessionId); if (!controller || activeAbort === controller) activeAbort = undefined; },
      clearWaitById: async (sessionId, waitId) => {
        this.assertId(sessionId);
        if (session.meta.wait?.id !== waitId) return false;
        await transactional(async () => { delete session.meta.wait; await persist(); });
        return true;
      },
      execRuntime,
    };
  }

  private createExecRuntime(session: Session): ExecRuntime {
    const workerDir = path.join(STATE_DIR, 'session-workers', encodeURIComponent(session.id));
    return createExecRuntime({
      getDefaultCwd: getAgentDir,
      getExecTempDir: agent => path.join(getAgentDir(agent), '.temp', 'exec'),
      registryPath: path.join(workerDir, 'running-exec.json'),
      nodeId: 'master',
      completionDispatcher: async (_entry, _status, message) => this.commitExecCompletion(message),
    });
  }

  private async commitExecCompletion(message: string): Promise<void> {
    if (!this.runner) {
      throw new RpcError('SESSION_WORKER_EXEC_RECOVERY_UNSUPPORTED', 'Recovered background exec completion cannot run before the Session worker host is initialized.', true);
    }
    await this.serialize(async () => {
      await this.ensureLoaded();
      await this.ensureHealthy();
      await this.applyAndPersistQueueItem({ type: 'background', parts: buildTimestampedSystemMessageParts(message) });
    });
    void this.runPending(256).catch(error => {
      logger.error({ err: error, sessionId: this.identity.sessionId }, 'Durable exec completion queue processing failed');
    });
  }

  private async applyAndPersistQueueItem(item: QueueItem): Promise<void> {
    await this.fenceMutation();
    const session = this.session!;
    this.assertSupportedQueue(session);
    const before = captureSessionSemanticState(session);
    try {
      const transition = applyQueuedItemToWaitState(session, item);
      if (transition.action === 'enqueue') session.queue.push(...transition.items);
      await this.persistOwner();
    } catch (error) {
      if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
      throw error;
    }
  }

  private compactionUnsupported(): RpcError {
    return new RpcError('SESSION_WORKER_COMPACTION_UNSUPPORTED', 'Session worker compaction is not implemented yet.', true);
  }

  private async persistOwner(): Promise<void> {
    await this.fenceMutation();
    if (this.poison) {
      const prior = this.poison;
      await this.ensureHealthy();
      throw new RpcError('SESSION_WORKER_RESYNCED_RETRY', 'Session worker resynchronized before a later mutation; retry that mutation.', true, {
        original: this.errorSummary(prior.original), resync: this.errorSummary(prior.resync),
      });
    }
    try {
      await this.persistence.persistActivated(this.session!, this.identity.generation, this.identity.incarnationId);
    } catch (error) {
      try { await this.persistence.reloadActivated(this.session!, this.identity.generation, this.identity.incarnationId); }
      catch (resync) { this.poison = { original: error, resync }; throw this.resyncError(error, resync); }
      throw new RpcError('SESSION_WORKER_PERSIST_FAILED', String((error as any)?.message || error), true, {
        original: this.errorSummary(error), resynced: true,
      });
    }
    await this.publishCurrent();
  }

  private async fenceMutation(): Promise<void> {
    if (!this.publicationPoison) return;
    await this.persistence.reloadActivated(this.session!, this.identity.generation, this.identity.incarnationId);
    throw this.publicationError(this.publicationPoison);
  }

  private async publishCurrent(): Promise<void> {
    if (!this.dependencies.publishCommitted) return;
    try { await this.dependencies.publishCommitted(buildSessionWorkerProjection(this.session!)); }
    catch (error) { logger.error({ err: error, sessionId: this.identity.sessionId }, 'Committed Session projection publication failed'); this.publicationPoison = error; throw this.publicationError(error); }
  }

  private publicationError(error: unknown): RpcError {
    return new RpcError('SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED', 'Committed Session state publication failed; worker restart/full resync is required.', true,
      { publication: this.errorSummary(error) });
  }

  private async ensureHealthy(): Promise<void> {
    if (this.publicationPoison) throw this.publicationError(this.publicationPoison);
    if (!this.poison) return;
    const prior = this.poison;
    try {
      await this.persistence.reloadActivated(this.session!, this.identity.generation, this.identity.incarnationId);
      this.poison = undefined;
    } catch (resync) {
      this.poison = { original: prior.original, resync };
      throw this.resyncError(prior.original, resync);
    }
  }

  private async resyncAfterFailure(original: unknown): Promise<void> {
    if (this.poison) throw this.resyncError(this.poison.original, this.poison.resync);
    try { await this.persistence.reloadActivated(this.session!, this.identity.generation, this.identity.incarnationId); }
    catch (resync) { this.poison = { original, resync }; throw this.resyncError(original, resync); }
  }

  private resyncError(original: unknown, resync: unknown): RpcError {
    return new RpcError('SESSION_WORKER_RESYNC_REQUIRED', 'Session worker mutation failed and authoritative resynchronization also failed.', true, {
      original: this.errorSummary(original), resync: this.errorSummary(resync),
    });
  }
  private errorSummary(error: unknown): { code?: string; message: string } {
    return { ...((error as any)?.code ? { code: String((error as any).code) } : {}), message: String((error as any)?.message || error) };
  }
  private isResyncError(error: unknown): boolean {
    return ['SESSION_WORKER_PERSIST_FAILED', 'SESSION_WORKER_RESYNCED_RETRY', 'SESSION_WORKER_RESYNC_REQUIRED',
      'SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED'].includes(String((error as any)?.code || ''));
  }

  private baseSession(): Session {
    return {
      id: this.identity.sessionId,
      history: [],
      persistentMemorySnapshot: '',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: 0 },
    };
  }

  private assertOwner(session: Session): void {
    if (session !== this.session) throw new RpcError('SESSION_WORKER_OWNER_MISMATCH', 'Session worker effect received a different Session owner.');
  }
  private assertId(sessionId: string): void {
    if (sessionId !== this.identity.sessionId) throw new RpcError('SESSION_WORKER_OWNER_MISMATCH', 'Session worker effect received a different session ID.');
  }
  private assertSupportedQueue(session: Session): void {
    if (getManagedSessionState(session) || session.queue.some(item => item.type === 'compact-commit')) {
      throw new RpcError('SESSION_WORKER_QUEUE_UNSUPPORTED', 'Managed-session and compact-commit queues are not supported by the Session worker yet.', true);
    }
  }
}
