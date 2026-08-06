import path from 'node:path';
import { STATE_DIR, getAgentDir } from './config';
import { createExecRuntime, type ExecRuntime } from './execManager';
import { initLlmRequestJournal } from './llmRequestJournal';
import type { CurrentSessionTurnEffects } from './llm';
import { RpcError } from './rpc';
import { initArchiveStore } from './session/archiveStore';
import { refreshSessionSnapshotForSession } from './session/agentMetadata';
import { captureSessionSemanticState, restoreSessionSemanticState } from './session/metadataStore';
import { appendSessionMessagesForSession, startSessionWaitForSession, updateSessionBusyStateForSession } from './sessionManager';
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
import { isQueueItem, type Message, type Session } from './types';

export type SessionWorkerHostDependencies = {
  persistence?: SessionWorkerPersistenceDependencies;
  initialize?: () => Promise<void>;
  createTurnHost?: (effects: CurrentSessionTurnEffects, session: Session) => SessionTurnHost;
};

export class SessionWorkerHost {
  private readonly persistence: SessionWorkerPersistence;
  private loadPromise?: Promise<void>;
  private runTail: Promise<void> = Promise.resolve();
  private session?: Session;
  private runner?: SessionTurnRunner;

  constructor(
    private readonly identity: SessionWorkerIdentity,
    store: SessionWorkerStore,
    private readonly dependencies: SessionWorkerHostDependencies = {},
  ) {
    this.persistence = new SessionWorkerPersistence(store, dependencies.persistence);
  }

  async runPending(limit: number): Promise<SessionWorkerProjection> {
    const run = this.runTail.then(() => this.runPendingSerial(limit));
    this.runTail = run.then(() => {}, () => {});
    return run;
  }

  private async runPendingSerial(limit: number): Promise<SessionWorkerProjection> {
    await this.ensureLoaded();
    const session = this.session!;
    try {
      await this.persistence.applyAndPersistPendingPrefix(
        session,
        this.identity.generation,
        this.identity.incarnationId,
        limit,
        (owner, intents) => {
          for (const intent of intents) {
            if (intent.kind !== 'enqueue' || !isQueueItem(intent.payload)) {
              throw new RpcError('SESSION_WORKER_INVALID_QUEUE_ITEM', 'Session worker mailbox payload is not a current QueueItem.');
            }
            owner.queue.push(structuredClone(intent.payload));
          }
        },
      );
      await this.runner!.processSessionQueue(session.id);
    } catch (error) {
      await this.persistence.reloadActivated(session, this.identity.generation, this.identity.incarnationId);
      throw error;
    }
    return buildSessionWorkerProjection(session);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    if (this.dependencies.initialize) await this.dependencies.initialize();
    else await Promise.all([initArchiveStore(), initLlmRequestJournal()]);
    const session = await this.persistence.loadActivated(this.baseSession(), this.identity.generation, this.identity.incarnationId);
    const execRuntime = this.createExecRuntime(session);
    await execRuntime.initialize();
    const effects = this.createEffects(session, execRuntime);
    this.session = session;
    this.runner = new SessionTurnRunner((this.dependencies.createTurnHost || ((ownerEffects, owner) => new LocalSessionTurnHost(
      ownerEffects,
      owner,
      async sessionId => {
        this.assertId(sessionId);
        const before = captureSessionSemanticState(owner);
        try {
          return await refreshSessionSnapshotForSession(owner, () => this.persistence.persistActivated(
            owner, this.identity.generation, this.identity.incarnationId,
          ).then(() => {}));
        } catch (error) {
          restoreSessionSemanticState(owner, before);
          throw error;
        }
      },
    )))(effects, session));
  }

  private createEffects(session: Session, execRuntime: ExecRuntime): CurrentSessionTurnEffects {
    const persist = () => this.persistence.persistActivated(session, this.identity.generation, this.identity.incarnationId).then(() => {});
    const transactional = async (operation: () => Promise<void>): Promise<void> => {
      const before = captureSessionSemanticState(session);
      try { await operation(); }
      catch (error) { restoreSessionSemanticState(session, before); throw error; }
    };
    const appendMessages = (owner: Session, messages: Message[]) => transactional(async () => {
      this.assertOwner(owner);
      await appendSessionMessagesForSession(owner, messages, persist, () => {});
    });
    let activeAbort: AbortController | undefined;
    return {
      appendMessage: (owner, message) => appendMessages(owner, [message]),
      appendMessages,
      persistSession: owner => { this.assertOwner(owner); return persist(); },
      updateBusy: (owner, busy) => { this.assertOwner(owner); return updateSessionBusyStateForSession(owner, busy, persist, clearActiveSessionRuntimeState); },
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
      completionDispatcher: async (_entry, _status, message) => {
        const before = captureSessionSemanticState(session);
        try {
          session.queue.push({ type: 'background', parts: [{ system: message }] });
          await this.persistence.persistActivated(session, this.identity.generation, this.identity.incarnationId);
        } catch (error) {
          restoreSessionSemanticState(session, before);
          throw error;
        }
      },
    });
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
}
