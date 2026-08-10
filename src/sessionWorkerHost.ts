import crypto from 'node:crypto';
import path from 'node:path';
import { logger } from './common';
import { STATE_DIR, getAgentDir } from './config';
import { createExecRuntime, type ExecRuntime } from './execManager';
import { initLlmRequestJournal } from './llmRequestJournal';
import type { CurrentSessionTurnEffects } from './llm';
import { RpcError } from './rpc';
import { initArchiveStore } from './session/archiveStore';
import { refreshSessionSnapshotForSession } from './session/agentMetadata';
import { clearSession, deleteMessages, forceIndexSession, getEffectiveCompactThresholdTokens, getUsageTotalTokens, processSessionCompactionRequest, type SessionHistoryDeps } from './session/history';
import { getManagedSessionState } from './session/managedState';
import { captureSessionSemanticState, restoreSessionSemanticState } from './session/metadataStore';
import { applyQueuedItemToWaitState, appendSessionMessagesForSession, buildManualForkNotificationMessage, startSessionWaitForSession, updateSessionBusyStateForSession } from './sessionManager';
import { clearActiveSessionRuntimeState, setActiveSessionRuntimeState, setSessionRuntimeStateUpdateCallback } from './sessionRuntimeState';
import { LocalSessionTurnHost, SessionTurnRunner, type SessionTurnHost } from './sessionTurnRunner';
import type { SessionTurnFinalKind } from './sessionTurnDelivery';
import {
  buildSessionWorkerProjection,
  SessionWorkerPersistence,
  type SessionWorkerPersistenceDependencies,
  type SessionWorkerProjection,
} from './sessionWorkerPersistence';
import type { SessionWorkerIdentity } from './sessionWorkerControlService';
import type { SessionWorkerStore } from './sessionWorkerStore';
import { isQueueItem, type CompactionRequest, type Message, type QueueItem, type QueueSource, type Session, type SessionStreamEvent } from './types';
import { buildTimestampedSystemMessageParts } from './utils/systemMessageParts';
import type { SessionWorkerHistoryMutationResult, SessionWorkerSettings, SessionWorkerSettingsPatch, SessionWorkerSettingsResult } from './sessionWorkerRuntimeService';

export type SessionWorkerHostDependencies = {
  persistence?: SessionWorkerPersistenceDependencies;
  initialize?: () => Promise<void>;
  createTurnHost?: (effects: CurrentSessionTurnEffects, session: Session) => SessionTurnHost;
  publishCommitted?: (projection: SessionWorkerProjection) => Promise<void>;
  deliverIntermediateText?: (source: QueueSource, text: string) => Promise<void>;
  deliverCommittedFinal?: (source: NonNullable<QueueItem['source']>, text: string, outcome: SessionTurnFinalKind) => Promise<void>;
  /** Transient presentation channel: appended-message copies for the WebUI fan-out. */
  publishPresentationMessage?: (message: Message) => Promise<void>;
  /** Transient presentation channel: model-stream events for the WebUI fan-out. */
  publishPresentationStream?: (event: SessionStreamEvent) => Promise<void>;
};

export class SessionWorkerHost {
  private readonly persistence: SessionWorkerPersistence;
  private loadPromise?: Promise<void>;
  private runTail: Promise<void> = Promise.resolve();
  private serializedPending = 0;
  private session?: Session;
  private runner?: SessionTurnRunner;
  private execRuntime?: ExecRuntime;
  private activeAbort?: AbortController;
  private poison?: { original: unknown; resync: unknown };
  private publicationPoison?: unknown;
  private transientPublishTail: Promise<void> = Promise.resolve();
  private presentationSubscribed = false;
  private presentationTail: Promise<void> = Promise.resolve();
  private coalescedStreamEvents = new Map<string, SessionStreamEvent>();
  private streamCoalesceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly identity: SessionWorkerIdentity,
    store: SessionWorkerStore,
    private readonly dependencies: SessionWorkerHostDependencies = {},
  ) {
    this.persistence = new SessionWorkerPersistence(store, dependencies.persistence);
    // Presentation-only publication: runtime phase transitions
    // (requesting-model/running-tool/idle) are transient process-local state
    // that is never written to authority. Without this wiring the updates only
    // reached Main piggybacked on authoritative commits, leaving the served
    // projection stuck on the last committed phase after a turn ended (local
    // placement wires the same callback to notifySessionUpdated). Publish the
    // current projection on every transition — fire-and-forget on a dedicated
    // tail that orders transient publishes among themselves but NEVER couples
    // to the serialized host chain: a stuck Main-side publication must not
    // wedge future turns. Each publish is time-bounded and failures only log —
    // the next authoritative commit republishes full state.
    setSessionRuntimeStateUpdateCallback(sessionId => {
      if (sessionId !== this.identity.sessionId) return;
      const task = this.transientPublishTail.then(async () => {
        if (!this.session || !this.dependencies.publishCommitted) return;
        const publish = this.dependencies.publishCommitted(buildSessionWorkerProjection(this.session));
        try {
          await Promise.race([
            publish,
            new Promise((_, reject) => setTimeout(() => reject(new Error('transient projection publication timed out')), 5_000)),
          ]);
        } catch (error) {
          logger.warn({ err: error, sessionId: this.identity.sessionId }, 'Transient runtime-state projection publication failed');
        }
      });
      this.transientPublishTail = task.then(() => {}, () => {});
    });
  }

  async runPending(limit: number): Promise<SessionWorkerProjection> {
    const run = this.serialize(() => this.runPendingSerial(limit));
    return run;
  }

  async retry(source?: QueueSource): Promise<SessionWorkerProjection> {
    if (this.serializedPending > 0) throw new RpcError('SESSION_WORKER_RETRY_BUSY', 'Session worker is already processing work.', true);
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy();
      try {
        await this.ingestPendingMailbox(4096);
        await this.runner!.processSessionRetry(this.session!.id, source);
      } catch (error) {
        if (String((error as any)?.code || '') !== 'SESSION_WORKER_AUTO_COMPACTION_FATAL') await this.resyncAfterFailure(error);
        throw error;
      } finally { this.flushCoalescedStreamEvents(); }
      return buildSessionWorkerProjection(this.session!);
    });
  }

  async loadProjection(): Promise<SessionWorkerProjection> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      await this.ensureHealthy();
      return buildSessionWorkerProjection(this.session!);
    });
  }

  async compactAwaited(request: CompactionRequest): Promise<{ compacted: boolean; projection: SessionWorkerProjection }> {
    if (this.serializedPending > 0) throw new RpcError('SESSION_WORKER_COMPACTION_BUSY', 'Session worker is not idle for awaited compaction.', true);
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy();
      const owner = this.session!;
      if (owner.busy || owner.queue.length || getManagedSessionState(owner)) throw new RpcError('SESSION_WORKER_COMPACTION_BUSY', 'Session worker is not idle for awaited compaction.', true);
      const compacted = await this.runExactCompaction(request, 'explicit');
      return { compacted, projection: buildSessionWorkerProjection(owner) };
    });
  }

  async updateSettings(patch: SessionWorkerSettingsPatch): Promise<SessionWorkerSettingsResult> {
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy(); await this.fenceMutation();
      const session = this.session!;
      const previous = this.settingsSnapshot(session);
      const before = captureSessionSemanticState(session);
      const changed: string[] = [];
      try {
        for (const key of ['cwd', 'model', 'childModelDefault', 'currentNode'] as const) {
          if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
          const value = patch[key];
          const prior = session[key] ?? null;
          if (prior !== value) changed.push(key);
          if (value === null) delete session[key]; else session[key] = value;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'compactThresholdTokens')) {
          const value = patch.compactThresholdTokens;
          const prior = typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null;
          if (prior !== value) changed.push('compactThresholdTokens');
          if (value === null) delete session.compactThresholdTokens; else session.compactThresholdTokens = value;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'verbose')) {
          const value = !!patch.verbose;
          const prior = !!session.verbose;
          if (prior !== value) changed.push('verbose');
          session.verbose = value;
        }
        if (changed.length > 0) await this.persistOwner();
        return { changed, previous, current: this.settingsSnapshot(session), projection: buildSessionWorkerProjection(session) };
      } catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    });
  }

  async deleteMessages(num: number): Promise<SessionWorkerHistoryMutationResult> {
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy(); await this.fenceMutation();
      const session = this.session!;
      const before = captureSessionSemanticState(session);
      try {
        const result = await deleteMessages(this.historyDeps(), session.id, num);
        return { ...result, projection: buildSessionWorkerProjection(session) };
      } catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    });
  }

  async clearHistory(): Promise<SessionWorkerHistoryMutationResult> {
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy(); await this.fenceMutation();
      const session = this.session!;
      const before = captureSessionSemanticState(session);
      try {
        await clearSession(this.historyDeps(), session.id);
        return { projection: buildSessionWorkerProjection(session) };
      } catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    });
  }

  async forceIndex(): Promise<SessionWorkerHistoryMutationResult> {
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy(); await this.fenceMutation();
      const session = this.session!;
      const before = captureSessionSemanticState(session);
      try {
        await forceIndexSession(this.historyDeps(), session.id);
        return {
          latestSeq: Math.max(0, (session.nextMessageSeq || 1) - 1),
          projection: buildSessionWorkerProjection(session),
        };
      } catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    });
  }

  async refreshSnapshot(): Promise<SessionWorkerHistoryMutationResult> {
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy(); await this.fenceMutation();
      const session = this.session!;
      const before = captureSessionSemanticState(session);
      try {
        await refreshSessionSnapshotForSession(session, () => this.persistOwner());
        return { agentName: session.agent || 'main', projection: buildSessionWorkerProjection(session) };
      } catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    });
  }

  async notifyManualForkCreated(childSessionId: string, initialMessage?: string): Promise<{ result: 'appended' | 'queued' }> {
    return this.serialize(async () => {
      await this.ensureLoaded(); await this.ensureHealthy(); await this.fenceMutation();
      const session = this.session!;
      const notification = buildManualForkNotificationMessage(session.id, childSessionId, initialMessage);
      if (session.busy) {
        await this.applyAndPersistQueueItem({ type: 'background', message: notification });
        return { result: 'queued' };
      }
      const before = captureSessionSemanticState(session);
      try {
        await appendSessionMessagesForSession(session, [notification], () => this.persistOwner(), () => {});
        this.forwardAppendedMessages([notification]);
        return { result: 'appended' };
      } catch (error) {
        if (!this.isResyncError(error)) restoreSessionSemanticState(session, before);
        throw error;
      }
    });
  }

  async idleStatus(): Promise<{ busy: boolean; queueLength: number; runningExecCount: number }> {
    // A worker that never loaded owns no hot state and has nothing to hand back.
    if (!this.session && !this.loadPromise) return { busy: false, queueLength: 0, runningExecCount: 0 };
    return this.serialize(async () => {
      await this.ensureLoaded();
      const session = this.session!;
      return {
        busy: !!session.busy,
        queueLength: session.queue?.length || 0,
        runningExecCount: this.execRuntime?.listRunningExecs().length || 0,
      };
    });
  }

  async interrupt(): Promise<{ stopping: boolean; abortedInFlight: boolean }> {
    // Two layers. (1) The stop signal is immediate: abort the active provider
    // request and set the in-memory stopping flag that the in-flight turn polls
    // — neither may wait on the serialized host chain, or interrupting a wedged
    // turn would hang behind that same turn (mirrors local requestSessionStop,
    // which also signals through the shared in-memory flag). (2) Durability is
    // serialized: the stopping flag is persisted transactionally on the host
    // chain so it lands after the turn's own final writes; that persist is
    // detached so a turn that ignores its abort can never block this RPC.
    const controller = this.activeAbort;
    const abortedInFlight = !!controller;
    await this.ensureLoaded();
    // Set the stop signal before aborting: the abort rejection reaches the
    // runner through microtasks, and the stopped-turn path requires
    // session.stopping to already be true (mirrors local requestSessionStop).
    this.session!.stopping = true;
    controller?.abort();
    void this.serialize(async () => {
      await this.fenceMutation();
      this.session!.stopping = true;
      await this.persistOwner();
    }).catch(error => logger.error({ err: error, sessionId: this.identity.sessionId }, 'Session worker interrupt persistence failed'));
    return { stopping: true, abortedInFlight };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.serializedPending += 1;
    const run = this.runTail.then(operation).finally(() => { this.serializedPending -= 1; });
    this.runTail = run.then(() => {}, () => {});
    return run;
  }

  private async runPendingSerial(limit: number): Promise<SessionWorkerProjection> {
    await this.ensureLoaded();
    await this.ensureHealthy();
    const session = this.session!;
    try {
      await this.ingestPendingMailbox(limit);
      await this.runner!.processSessionQueue(session.id);
    } catch (error) {
      if (String((error as any)?.code || '') !== 'SESSION_WORKER_AUTO_COMPACTION_FATAL') await this.resyncAfterFailure(error);
      throw error;
    } finally {
      // Turn boundary: flush any coalesced stream delta so the final frame is
      // never stranded in the 500ms window after the turn ends.
      this.flushCoalescedStreamEvents();
    }
    return buildSessionWorkerProjection(session);
  }

  /**
   * Apply the exact durable mailbox prefix without starting a second queue
   * runner. The canonical runner calls this only at persisted safe points while
   * it already owns the host serial lane, allowing provider-time follow-ups to
   * join the active turn without concurrent Session mutation.
   */
  private async ingestPendingMailbox(limit: number): Promise<void> {
    const session = this.session!;
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
  }

  /** Main-driven subscription gate: transient presentation forwards only run while subscribed. */
  setPresentationSubscription(active: boolean): void {
    this.presentationSubscribed = active === true;
    if (!this.presentationSubscribed) {
      this.coalescedStreamEvents.clear();
      if (this.streamCoalesceTimer) { clearTimeout(this.streamCoalesceTimer); this.streamCoalesceTimer = undefined; }
    }
  }

  private forwardPresentation(send: () => Promise<void>): void {
    const task = this.presentationTail.then(async () => {
      try {
        await Promise.race([
          send(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('presentation forward timed out')), 5_000)),
        ]);
      } catch (error) {
        logger.warn({ err: error, sessionId: this.identity.sessionId }, 'Transient presentation forward failed');
      }
    });
    this.presentationTail = task.then(() => {}, () => {});
  }

  /** Presentation-only copies of appended messages; never semantic state. */
  private forwardAppendedMessages(messages: Message[]): void {
    if (!this.presentationSubscribed || !this.dependencies.publishPresentationMessage) return;
    for (const message of messages) {
      const copy = JSON.parse(JSON.stringify(message)) as Message;
      this.forwardPresentation(() => this.dependencies.publishPresentationMessage!(copy));
    }
  }

  private static readonly STREAM_COALESCE_MS = 500;

  private forwardSessionStreamEvent(event: SessionStreamEvent): void {
    if (!this.presentationSubscribed || !this.dependencies.publishPresentationStream) return;
    if (event.type === 'model-stream-reset') {
      // Resets are structural (draft lifecycle), forward immediately.
      const copy = JSON.parse(JSON.stringify(event)) as SessionStreamEvent;
      this.forwardPresentation(() => this.dependencies.publishPresentationStream!(copy));
      return;
    }
    if (event.type !== 'model-stream-update') return;
    // Coalesce per streamId: frames carry cumulative snapshots and WebUI
    // replaces the draft wholesale, so keeping the latest frame per 500ms
    // window loses nothing.
    const streamId = (event as any).streamId || 'current';
    this.coalescedStreamEvents.set(streamId, JSON.parse(JSON.stringify(event)) as SessionStreamEvent);
    if (!this.streamCoalesceTimer) {
      this.streamCoalesceTimer = setTimeout(() => {
        this.streamCoalesceTimer = undefined;
        this.flushCoalescedStreamEvents();
      }, SessionWorkerHost.STREAM_COALESCE_MS);
    }
  }

  private flushCoalescedStreamEvents(): void {
    if (!this.coalescedStreamEvents.size) return;
    const pending = [...this.coalescedStreamEvents.values()];
    this.coalescedStreamEvents.clear();
    if (!this.presentationSubscribed || !this.dependencies.publishPresentationStream) return;
    for (const event of pending) {
      this.forwardPresentation(() => this.dependencies.publishPresentationStream!(event));
    }
  }

  /**
   * A freshly spawned incarnation cannot have an in-flight turn, so a persisted
   * busy flag at load is stale from a crashed predecessor. Recovery clears the
   * stale flags and enqueues the restart system event for the canonical runner
   * to consume — entirely inside this exact worker's ownership, mirroring the
   * local resumeBusySessions semantics without a second recovery channel.
   */
  private async recoverStaleBusy(session: Session): Promise<void> {
    // A freshly spawned incarnation has no in-flight turn, so a persisted busy
    // or stopping flag is necessarily residue from a previous incarnation —
    // a persisted stopping=true would otherwise silently stop the next turn
    // (the runner halts on the flag), which local placement never does because
    // its stop signal is in-memory only.
    const staleBusy = session.busy === true;
    const staleStopping = session.stopping === true;
    if (!staleBusy && !staleStopping) return;
    logger.warn({ sessionId: session.id, generation: this.identity.generation, staleBusy, staleStopping }, 'Session worker recovering stale busy/stopping state from a previous incarnation');
    session.busy = false;
    session.busyStartedAt = undefined;
    session.stopping = false;
    if (staleBusy) {
      const restartMarker = 'Session worker restarted after an unconfirmed exit; resuming interrupted work.';
      const alreadyQueued = (session.queue || []).some(item => JSON.stringify(item.parts || []).includes('Session worker restarted after an unconfirmed exit'));
      if (!alreadyQueued) {
        session.queue = [...(session.queue || []), {
          id: crypto.randomUUID(), type: 'background',
          parts: buildTimestampedSystemMessageParts(restartMarker), queuedAt: Date.now(),
        } as QueueItem];
      }
    }
    await this.persistOwner();
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
    await this.recoverStaleBusy(session);
    const execRuntime = this.createExecRuntime(session);
    try { await execRuntime.initialize(); }
    catch (error) { throw new RpcError('SESSION_WORKER_INITIALIZATION_FAILED', `Session worker ExecRuntime initialization failed: ${(error as any)?.message || error}`, true); }
    this.execRuntime = execRuntime;
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
        processSessionCompactionRequest: async (sessionId, request) => {
          this.assertId(sessionId); await this.runAutomaticCompaction(request, 'pre-final');
        },
        checkAndCompactIfNeeded: async (sessionId, usage) => {
          this.assertId(sessionId);
          const total = getUsageTotalTokens(usage);
          if (total > 0 && total > getEffectiveCompactThresholdTokens(owner)) await this.runAutomaticCompaction({ completionMarker: 'Compaction completed.' }, 'post-final');
        },
        ingestPendingQueue: async candidate => {
          this.assertOwner(candidate);
          await this.ensureHealthy();
          await this.ingestPendingMailbox(4096);
        },
        ...(this.dependencies.deliverCommittedFinal ? {
          deliverCommittedFinal: async (_session, source, text, outcome) => {
            try { await this.dependencies.deliverCommittedFinal!(source, text, outcome); }
            catch (error) { logger.error({ err: error, sessionId: owner.id, outcome }, 'Committed final reverse delivery failed'); }
          },
        } : {}),
        ...(this.dependencies.deliverIntermediateText ? {
          deliverIntermediateText: async (_session, source, text) => {
            try { await this.dependencies.deliverIntermediateText!(source, text); }
            catch (error) { logger.error({ err: error, sessionId: owner.id }, 'Intermediate Worker channel delivery failed'); }
          },
        } : {}),
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
      this.forwardAppendedMessages(messages);
    });
    let activeAbort: AbortController | undefined;
    return {
      placement: 'session-worker',
      appendMessage: (owner, message) => appendMessages(owner, [message]),
      appendMessages,
      persistSession: owner => { this.assertOwner(owner); return persist(); },
      updateBusy: async (owner, busy) => {
        this.assertOwner(owner);
        const update = () => transactional(() => updateSessionBusyStateForSession(
          owner, busy, persist, clearActiveSessionRuntimeState, undefined,
          error => String((error as any)?.code || '') !== 'SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED',
        ));
        try { await update(); }
        catch (error) {
          if (busy || String((error as any)?.code || '') !== 'SESSION_WORKER_RESYNCED_RETRY') throw error;
          await update();
        }
      },
      startWait: (owner, options) => {
        this.assertOwner(owner);
        let result: Awaited<ReturnType<typeof startSessionWaitForSession>>;
        return transactional(async () => { result = await startSessionWaitForSession(owner, options, persist); }).then(() => result!);
      },
      notifyHistoryUpdate: () => {},
      notifySessionEvent: (_sessionId, event) => { this.forwardSessionStreamEvent(event); },
      setRuntimeState: setActiveSessionRuntimeState,
      clearRuntimeState: clearActiveSessionRuntimeState,
      registerAbortController: (sessionId, controller) => { this.assertId(sessionId); activeAbort = controller; this.activeAbort = controller; },
      clearAbortController: (sessionId, controller) => { this.assertId(sessionId); if (!controller || activeAbort === controller) { activeAbort = undefined; this.activeAbort = undefined; } },
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
    return new RpcError('SESSION_WORKER_COMPACTION_UNSUPPORTED', 'Background compact commits are not supported by synchronous Session-worker placement.', true);
  }

  private historyDeps(): SessionHistoryDeps {
    return {
      getSessionById: id => { this.assertId(id); return this.session; },
      getExistingSession: async id => { this.assertId(id); return this.session || null; },
      saveSession: async id => { this.assertId(id); await this.persistOwner(); },
      notifyHistoryUpdate: () => {},
    };
  }

  private settingsSnapshot(session: Session): SessionWorkerSettings {
    return {
      cwd: session.cwd || null,
      model: session.model || null,
      childModelDefault: session.childModelDefault || null,
      currentNode: session.currentNode || null,
      compactThresholdTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : null,
      verbose: !!session.verbose,
    };
  }

  private async runExactCompaction(request: CompactionRequest, failurePolicy: 'explicit' | 'pre-final' | 'post-final'): Promise<boolean> {
    await this.fenceMutation();
    const beforeVersion = this.session!.historyVersion || 0;
    try {
      await processSessionCompactionRequest(this.historyDeps(), this.identity.sessionId, request, 'await');
      return (this.session!.historyVersion || 0) !== beforeVersion;
    } catch (error) {
      try { await this.resyncAfterFailure(error); }
      catch (resync) {
        if (failurePolicy === 'post-final') { logger.error({ err: resync, sessionId: this.identity.sessionId }, 'Post-final Worker compaction failed and authority resync is unavailable'); return false; }
        if (failurePolicy === 'explicit') throw resync;
        throw new RpcError('SESSION_WORKER_AUTO_COMPACTION_FATAL', 'Automatic Worker compaction failed before final delivery and authority could not be safely resynchronized.', true,
          { original: this.errorSummary(error), resync: this.errorSummary(resync) });
      }
      if (failurePolicy === 'explicit') throw error;
      if (failurePolicy === 'pre-final' && (this.poison || this.publicationPoison)) {
        throw new RpcError('SESSION_WORKER_AUTO_COMPACTION_FATAL', 'Automatic Worker compaction failed before final delivery and the owner remains mutation-fenced.', true,
          { original: this.errorSummary(error) });
      }
      logger.warn({ err: error, sessionId: this.identity.sessionId }, 'Automatic Worker compaction failed without affecting the delivered turn');
      return false;
    }
  }

  private runAutomaticCompaction(request: CompactionRequest, failurePolicy: 'pre-final' | 'post-final'): Promise<boolean> {
    return this.runExactCompaction(request, failurePolicy);
  }

  private async persistOwner(): Promise<void> {
    await this.fenceMutation();
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
    if (this.publicationPoison) {
      await this.persistence.reloadActivated(this.session!, this.identity.generation, this.identity.incarnationId);
      throw this.publicationError(this.publicationPoison);
    }
    if (this.poison) {
      const prior = this.poison;
      await this.ensureHealthy();
      throw new RpcError('SESSION_WORKER_RESYNCED_RETRY', 'Session worker resynchronized before a later mutation; retry that mutation.', true, {
        original: this.errorSummary(prior.original), resync: this.errorSummary(prior.resync),
      });
    }
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
