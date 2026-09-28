/** Canonical per-session queue and turn state machine. */

import { randomUUID } from 'crypto';
import { logger } from './common';
import { ChannelContext, getChannelId, getConversationId } from './channel';
import { buildChildReminder, isNoActionSignalText } from './session/childSessionReminder';
import { getManagedSessionState, setManagedSessionState } from './session/managedState';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
import { maybeRefreshStaleSessionSnapshot } from './session/snapshotRefresh';
import { maybeBuildGoalReminderMessage } from './session/goal';
import { isSessionArchiveCommitError } from './session/archive';
import { isSessionAuthorityPostCommitError } from './session/stateFile';
import { isSessionTurnIncomplete, SessionContinuationUnavailableError } from './sessionContinuation';
import { buildSessionRuntimeState } from './sessionRuntimeState';
import { snapshotQueueSource, type SessionTurnFinalKind } from './sessionTurnDelivery';
import { applyChildHandoffQueueItem, resolveChildHandoffBoundary, shouldQueueChildHandoffReminder } from './session/childHandoffState';
import * as sessionManager from './sessionManager';
import { finishChannelTurnProgress, reportChannelTurnProgress } from './session/channels';
import { armMainWaitLiveness } from './mainManagementTools';
import * as llm from './llm';
import { ChannelTurnProgress, ChannelTurnToolResult, FunctionCall, isQueueItem, Message, MessagePart, QueueItem, QueueSource, Session, TokenUsage } from './types';
import { formatFoxwarmSystemTag } from './utils/promptWrappers';

export function shouldBroadcastChannelText(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

export function formatTerminalSessionError(error: any): string {
  return llm.isLlmRequestError(error)
    ? `⚠️ LLM request failed: ${error?.message || 'Unknown error'}`
    : `Error: ${error?.message || 'Unknown error'}`;
}

function formatRetryDelay(delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function formatRetryReason(event: llm.LlmRetryEvent): string {
  const status = `${event.status || ''}`.replace(/\s+/g, ' ').trim();
  const reason = `${event.reason || ''}`.replace(/\s+/g, ' ').trim();
  return status ? `${status}: ${reason}`.trim() : reason;
}

function formatRetryStatus(event: llm.LlmRetryEvent, initial: boolean): string {
  const reason = formatRetryReason(event);
  const retryText = event.final
    ? 'No more retries.'
    : `Retry in ${formatRetryDelay(event.delayMs || 0)}...`;
  const attemptText = reason
    ? `Attempt ${event.attempt}/${event.maxRetries} failed: ${reason}. ${retryText}`
    : `Attempt ${event.attempt}/${event.maxRetries} failed. ${retryText}`;
  if (initial) {
    return `⚠️ LLM Error: ${attemptText}`;
  }

  return `\n${attemptText}`;
}

function formatRetryChannelSnippet(event: llm.LlmRetryEvent): string {
  const reason = formatRetryReason(event);
  const retryText = event.final
    ? 'No more retries.'
    : `Retry in ${formatRetryDelay(event.delayMs || 0)}...`;
  const failureText = reason
    ? `Attempt ${event.attempt}/${event.maxRetries} failed: ${reason}.`
    : `Attempt ${event.attempt}/${event.maxRetries} failed.`;
  return `⚠️ LLM Error: ${failureText} ${retryText}`;
}

type RetryErrorDescriptor = Pick<llm.LlmRetryEvent, 'status' | 'reason'>;

function mergeExcludePlatforms(options: any, platforms: string[]): any {
  const excludePlatforms = Array.from(new Set([...(options?.excludePlatforms || []), ...platforms]));
  return { ...(options || {}), excludePlatforms };
}

/** Placement effects currently required by the canonical turn runner. */
export interface SessionTurnHost {
  getSession: typeof sessionManager.getSession;
  getExistingSession: typeof sessionManager.getExistingSession;
  isSessionDestructiveLifecycleClaimed: typeof sessionManager.isSessionDestructiveLifecycleClaimed;
  updateSessionBusyState: typeof sessionManager.updateSessionBusyState;
  saveSession(session: Session): Promise<void>;
  appendSessionMessage: typeof sessionManager.appendSessionMessage;
  appendSessionMessages: typeof sessionManager.appendSessionMessages;
  appendQueuedSessionMessages: typeof sessionManager.appendQueuedSessionMessages;
  notifyHistoryUpdate: typeof sessionManager.notifyHistoryUpdate;
  applyCompletedCompactJob: typeof sessionManager.applyCompletedCompactJob;
  processSessionCompactionRequest: typeof sessionManager.processSessionCompactionRequest;
  checkAndCompactIfNeeded: typeof sessionManager.checkAndCompactIfNeeded;
  startSessionWait(session: Session, options?: Parameters<typeof sessionManager.startSessionWaitForSession>[1]): Promise<sessionManager.SessionWaitState>;
  queueSessionSystemEvent: typeof sessionManager.queueSessionSystemEvent;
  setActiveSessionRuntimeState: typeof sessionManager.setActiveSessionRuntimeState;
  clearActiveSessionRuntimeState: typeof sessionManager.clearActiveSessionRuntimeState;
  refreshSessionSnapshot: typeof sessionManager.refreshSessionSnapshot;
  chat: typeof llm.chat;
  executeTools: typeof llm.executeTools;
  sendTyping(sourceCtx: ChannelContext): Promise<void>;
  hasBroadcast(session: Session): boolean;
  broadcast(session: Session, text: string, options?: any): void;
  ingestPendingQueue?(session: Session): Promise<void>;
  deliverIntermediateText?(session: Session, text: string, turnId: string): Promise<void>;
  deliverCommittedFinal?(session: Session, text: string, outcome: SessionTurnFinalKind, turnId: string): Promise<void>;
  reportChannelProgress?(session: Session, turnId: string, progress: ChannelTurnProgress): void | Promise<void>;
  finishChannelProgress?(session: Session, turnId: string): Promise<void>;
}

export type LocalSessionTurnHostOverrides = Partial<Pick<SessionTurnHost,
  'applyCompletedCompactJob' | 'processSessionCompactionRequest' | 'checkAndCompactIfNeeded'
  | 'queueSessionSystemEvent' | 'refreshSessionSnapshot' | 'ingestPendingQueue' | 'deliverIntermediateText' | 'deliverCommittedFinal'
  | 'reportChannelProgress' | 'finishChannelProgress'>>;

/** Existing in-process effects, exposed without changing their behavior. */
export class LocalSessionTurnHost implements SessionTurnHost {
  private readonly currentSessionEffects: llm.CurrentSessionTurnEffects;
  readonly deliverCommittedFinal?: SessionTurnHost['deliverCommittedFinal'];
  readonly deliverIntermediateText?: SessionTurnHost['deliverIntermediateText'];
  readonly ingestPendingQueue?: SessionTurnHost['ingestPendingQueue'];

  constructor(
    effects?: llm.CurrentSessionEffects,
    private readonly ownerSession?: Session,
    private readonly overrides: LocalSessionTurnHostOverrides = {},
  ) {
    const defaults = llm.createDefaultCurrentSessionEffects();
    effects ||= defaults;
    const turnEffects = effects as Partial<llm.CurrentSessionTurnEffects>;
    const bind = <T extends (...args: any[]) => any>(method: T): T => method.bind(effects) as T;
    const notifyHistoryUpdate = turnEffects.notifyHistoryUpdate ? bind(turnEffects.notifyHistoryUpdate) : defaults.notifyHistoryUpdate;
    this.currentSessionEffects = {
      ...defaults,
      placement: effects.placement || 'local',
      appendMessage: bind(effects.appendMessage),
      persistSession: bind(effects.persistSession),
      persistSessionStrict: effects.persistSessionStrict
        ? bind(effects.persistSessionStrict)
        : bind(effects.persistSession),
      notifySessionEvent: bind(effects.notifySessionEvent),
      registerAbortController: bind(effects.registerAbortController),
      clearAbortController: bind(effects.clearAbortController),
      clearWaitById: bind(effects.clearWaitById),
      ...(effects.execRuntime ? { execRuntime: effects.execRuntime } : {}),
      appendMessages: turnEffects.appendMessages
        ? bind(turnEffects.appendMessages)
        : (async (session, messages) => { await sessionManager.appendSessionMessagesForSession(
          session, messages, () => effects.persistSession(session), notifyHistoryUpdate,
        ); }),
      appendQueuedMessages: turnEffects.appendQueuedMessages
        ? bind(turnEffects.appendQueuedMessages)
        : ((session, messages) => sessionManager.appendQueuedSessionMessagesForSession(
          session, messages, () => effects.persistSession(session),
        )),
      updateBusy: turnEffects.updateBusy
        ? bind(turnEffects.updateBusy)
        : ((session, busy) => sessionManager.updateSessionBusyStateForSession(
          session,
          busy,
          () => effects.persistSession(session),
          defaults.clearRuntimeState,
          sessionManager.notifySessionStateUpdated,
        )),
      startWait: turnEffects.startWait
        ? bind(turnEffects.startWait)
        : ((session, options) => sessionManager.startSessionWaitForSession(session, options, () => effects.persistSession(session))),
      notifyHistoryUpdate,
      setRuntimeState: turnEffects.setRuntimeState ? bind(turnEffects.setRuntimeState) : defaults.setRuntimeState,
      clearRuntimeState: turnEffects.clearRuntimeState ? bind(turnEffects.clearRuntimeState) : defaults.clearRuntimeState,
    };
    this.deliverCommittedFinal = overrides.deliverCommittedFinal;
    this.deliverIntermediateText = overrides.deliverIntermediateText;
    this.ingestPendingQueue = overrides.ingestPendingQueue;
  }

  private assertOwnerId(sessionId: string): void {
    if (this.ownerSession && this.ownerSession.id !== sessionId) {
      throw new Error(`Local turn host is bound to session \`${this.ownerSession.id}\`, not \`${sessionId}\`.`);
    }
  }

  private assertOwnerSession(session: Session): void {
    this.assertOwnerId(session.id);
    if (this.ownerSession && this.ownerSession !== session) {
      throw new Error(`Local turn host rejected a different Session object for \`${session.id}\`.`);
    }
  }

  async getSession(sessionId: string): Promise<Session> {
    this.assertOwnerId(sessionId);
    return this.ownerSession || sessionManager.getSession(sessionId);
  }
  async getExistingSession(sessionId: string): Promise<Session | null> {
    this.assertOwnerId(sessionId);
    return this.ownerSession || sessionManager.getExistingSession(sessionId);
  }
  get isSessionDestructiveLifecycleClaimed(): typeof sessionManager.isSessionDestructiveLifecycleClaimed { return sessionManager.isSessionDestructiveLifecycleClaimed; }
  updateSessionBusyState(session: Session, busy: boolean): Promise<void> { this.assertOwnerSession(session); return this.currentSessionEffects.updateBusy(session, busy); }
  saveSession(session: Session): Promise<void> { this.assertOwnerSession(session); return this.currentSessionEffects.persistSession(session); }
  appendSessionMessage(session: Session, message: Message): Promise<void> { this.assertOwnerSession(session); return this.currentSessionEffects.appendMessage(session, message); }
  appendSessionMessages(session: Session, messages: Message[]): Promise<void> { this.assertOwnerSession(session); return this.currentSessionEffects.appendMessages(session, messages); }
  appendQueuedSessionMessages(session: Session, messages: Message[]): Promise<void> { this.assertOwnerSession(session); return this.currentSessionEffects.appendQueuedMessages(session, messages); }
  notifyHistoryUpdate(sessionId: string, message: Message): void { this.assertOwnerId(sessionId); this.currentSessionEffects.notifyHistoryUpdate(sessionId, message); }
  get applyCompletedCompactJob(): typeof sessionManager.applyCompletedCompactJob { return this.overrides.applyCompletedCompactJob || sessionManager.applyCompletedCompactJob; }
  get processSessionCompactionRequest(): typeof sessionManager.processSessionCompactionRequest { return this.overrides.processSessionCompactionRequest || sessionManager.processSessionCompactionRequest; }
  get checkAndCompactIfNeeded(): typeof sessionManager.checkAndCompactIfNeeded { return this.overrides.checkAndCompactIfNeeded || sessionManager.checkAndCompactIfNeeded; }
  startSessionWait(session: Session, options?: Parameters<typeof sessionManager.startSessionWaitForSession>[1]): Promise<sessionManager.SessionWaitState> { this.assertOwnerSession(session); return this.currentSessionEffects.startWait(session, options); }
  get queueSessionSystemEvent(): typeof sessionManager.queueSessionSystemEvent { return this.overrides.queueSessionSystemEvent || sessionManager.queueSessionSystemEvent; }
  setActiveSessionRuntimeState(sessionId: string, state: Parameters<typeof sessionManager.setActiveSessionRuntimeState>[1]): void { this.assertOwnerId(sessionId); this.currentSessionEffects.setRuntimeState(sessionId, state); }
  clearActiveSessionRuntimeState(sessionId: string): void { this.assertOwnerId(sessionId); this.currentSessionEffects.clearRuntimeState(sessionId); }
  get refreshSessionSnapshot(): typeof sessionManager.refreshSessionSnapshot { return this.overrides.refreshSessionSnapshot || sessionManager.refreshSessionSnapshot; }
  get chat(): typeof llm.chat {
    return (parts, session, iteration, options) => {
      this.assertOwnerSession(session);
      const effectiveEffects = options?.currentSessionEffects || this.currentSessionEffects;
      return llm.chat(parts, session, iteration, {
        ...options,
        appendMessage: options?.appendMessage || (message => effectiveEffects.appendMessage(session, message)),
        currentSessionEffects: effectiveEffects,
      });
    };
  }
  get executeTools(): typeof llm.executeTools {
    return (functionCalls, toolContext, session, options) => {
      this.assertOwnerSession(session);
      return llm.executeTools(functionCalls, toolContext, session, {
        ...options,
        currentSessionEffects: options?.currentSessionEffects || this.currentSessionEffects,
      });
    };
  }

  async sendTyping(sourceCtx: ChannelContext): Promise<void> { await sourceCtx.sendTyping(); }
  reportChannelProgress(session: Session, turnId: string, progress: ChannelTurnProgress): void {
    this.assertOwnerSession(session);
    if (this.overrides.reportChannelProgress) {
      this.overrides.reportChannelProgress(session, turnId, progress);
      return;
    }
    reportChannelTurnProgress(session.id, turnId, progress);
  }
  finishChannelProgress(session: Session, turnId: string): Promise<void> {
    this.assertOwnerSession(session);
    if (this.overrides.finishChannelProgress) return this.overrides.finishChannelProgress(session, turnId);
    return finishChannelTurnProgress(turnId);
  }
  hasBroadcast(session: Session): boolean { this.assertOwnerSession(session); return !!session.broadcast; }
  broadcast(session: Session, text: string, options?: any): void { this.assertOwnerSession(session); session.broadcast?.(text, options); }

}

export class SessionTurnRunner {
  private processingSessions: Set<string> = new Set();

  constructor(private readonly host: SessionTurnHost) {}

  snapshotSource(ctx: ChannelContext): QueueSource {
    return snapshotQueueSource(ctx);
  }

  private async emitTurnProgress(
    progress: ChannelTurnProgress,
    session?: Session,
    turnId?: string,
  ): Promise<void> {
    if (session && turnId) await this.host.reportChannelProgress?.(session, turnId, progress);
  }

  private getTurnToolCalls(toolCalls: FunctionCall[], iteration: number): FunctionCall[] {
    return toolCalls.map((call, index) => ({
      ...call,
      id: call.id || `tool_${iteration}_${index}`,
    }));
  }

  private getToolResultProgress(toolResultMsg: Message): ChannelTurnToolResult[] {
    return toolResultMsg.parts
      .filter(part => part.functionResponse?.tool_use_id)
      .map(part => ({
        id: part.functionResponse!.tool_use_id,
        name: part.functionResponse!.name || 'tool',
        status: part.functionResponse!.response?.error !== undefined && part.functionResponse!.response?.error !== null ? 'error' : 'success',
      }));
  }

  private createLlmRetryNotifier(
    session: Session,
    broadcast: Session['broadcast'] | undefined,
    turnId?: string,
    onTerminalDelivered?: () => void,
  ): (event: llm.LlmRetryEvent) => Promise<void> {
    let retryMessage: Message | null = null;
    let previousError: RetryErrorDescriptor | undefined;
    let eventCount = 0;

    return async (event: llm.LlmRetryEvent) => {
      const initial = eventCount === 0;
      const sameError = previousError !== undefined
        && previousError.status === event.status
        && previousError.reason === event.reason;
      const displayEvent = sameError ? { ...event, status: undefined, reason: '(same error)' } : event;
      previousError = { status: event.status, reason: event.reason };
      eventCount += 1;
      const chunk = formatRetryStatus(displayEvent, initial);
      if (!retryMessage) {
        retryMessage = createDisplayOnlyModelMessage(chunk, {
          noticeType: 'llm-retry',
          retry: {
            attempt: event.attempt,
            nextAttempt: event.nextAttempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            final: event.final,
            kind: event.kind,
            reason: event.reason,
            status: event.status,
          },
        });
        await this.host.appendSessionMessage(session, retryMessage);
      } else {
        const existingText = retryMessage.parts[0]?.text || '';
        retryMessage.parts[0] = {
          ...(retryMessage.parts[0] || {}),
          text: `${existingText}${chunk}`,
        };
        retryMessage.__meta = {
          ...(retryMessage.__meta || {}),
          timestamp: Date.now(),
          updateExisting: true,
          retry: {
            attempt: event.attempt,
            nextAttempt: event.nextAttempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            final: event.final,
            kind: event.kind,
            reason: event.reason,
            status: event.status,
          },
        };
        await this.host.saveSession(session);
        this.host.notifyHistoryUpdate(session.id, retryMessage);
      }

      const channelSnippet = formatRetryChannelSnippet(displayEvent);
      if (event.final === true) {
        if (this.host.deliverIntermediateText && this.host.deliverCommittedFinal && turnId) {
          await this.host.deliverIntermediateText(session, channelSnippet, turnId);
          await this.host.deliverCommittedFinal(session, '', 'empty-final', turnId);
          onTerminalDelivered?.();
        } else if (broadcast) {
          broadcast(channelSnippet, mergeExcludePlatforms({ parse_mode: 'Markdown', turnFinal: true }, ['webui']));
          onTerminalDelivered?.();
        }
      } else if (initial) {
        if (this.host.deliverIntermediateText && turnId) {
          await this.host.deliverIntermediateText(session, channelSnippet, turnId);
        } else if (broadcast) {
          broadcast(channelSnippet, mergeExcludePlatforms({ parse_mode: 'Markdown' }, ['webui']));
        }
      }
    };
  }

  private prepareTurnParts(session: Session, sessionId: string, parts: MessagePart[]): MessagePart[] {
    const finalParts = [...parts];

    session.meta.lastMessageTime = Date.now();

    if (session.history.length === 0) {
      finalParts.unshift({
        system: formatFoxwarmSystemTag({
          kind: 'session',
          currentSessionId: sessionId,
        }),
      });
    }

    return finalParts;
  }

  private drainLeadingQueuedTurnInputs(session: Session): QueueItem[] {
    const items: QueueItem[] = [];

    while (session.queue[0]) {
      if (!isQueueItem(session.queue[0])) {
        session.queue.shift();
        continue;
      }
      if (session.queue[0].type === 'compact-commit') {
        break;
      }
      const item = session.queue.shift();
      if (!item) continue;
      if (!item.message && !item.parts?.length) continue;
      items.push(item);
    }

    return items;
  }

  private async consumeLeadingQueuedTurnInputs(
    session: Session,
    pendingParts: MessagePart[] | null,
  ): Promise<{ parts: MessagePart[] | null; consumedInput: boolean }> {
    let parts = pendingParts;
    let consumedInput = false;

    if (parts?.length && this.inspectLeadingQueuedTurnInputs(session)) {
      await this.appendUserMessage(session, parts);
      parts = null;
    }
    const selected: QueueItem[] = [];
    while (session.queue[0]) {
      if (!isQueueItem(session.queue[0])) {
        session.queue.shift();
        continue;
      }
      if (session.queue[0].type === 'compact-commit') {
        break;
      }
      const item = session.queue.shift();
      if (!item) {
        continue;
      }

      if (item.message || item.parts?.length) selected.push(item);
    }

    if (selected.length > 0) {
      consumedInput = true;
      await this.appendQueuedTurnInputs(session, session.id, selected, false);
    }

    return {
      parts,
      consumedInput,
    };
  }

  private inspectLeadingQueuedTurnInputs(session: Session): boolean {
    for (const item of session.queue) {
      if (!isQueueItem(item)) continue;
      if (item.type === 'compact-commit') break;
      if (!item.message && !item.parts?.length) continue;
      return true;
    }
    return false;
  }

  private async appendQueuedTurnInputs(session: Session, sessionId: string, items: QueueItem[], firstStartsTurn = true): Promise<void> {
    let firstInputItem = true;
    const messages: Message[] = [];
    for (const item of items) {
      if (item.message) {
        messages.push(item.message);
        firstInputItem = false;
        continue;
      }
      if (!item.parts?.length) {
        continue;
      }

      // Only the first input item starts this turn, so it receives turn metadata.
      // Every queued item is still persisted as its own canonical message.
      const parts = firstStartsTurn && firstInputItem
        ? this.prepareTurnParts(session, sessionId, item.parts)
        : item.parts;
      messages.push({ role: 'user', parts, ...(item.clientMessageId ? { __meta: { clientMessageId: item.clientMessageId } } : {}) });
      firstInputItem = false;
    }
    if (messages.length === 0) return;
    try {
      await this.commitChildHandoffMutation(
        session,
        () => { for (const item of items) applyChildHandoffQueueItem(session, item); },
        () => this.host.appendQueuedSessionMessages(session, messages),
      );
    } catch (error) {
      if (!isSessionAuthorityPostCommitError(error)) session.queue.unshift(...items);
      throw error;
    }
  }

  private async finalizeStoppedSession(session: Session): Promise<number> {
    let committedMessages = 0;
    let committedAnyInput = false;

    while (true) {
      const messages: Message[] = [];
      const committedItems: QueueItem[] = [];
      let removedQueueItems = 0;
      let applyCompactCommit = false;

      for (const item of session.queue) {
        if (!isQueueItem(item)) {
          removedQueueItems += 1;
          continue;
        }
        if (item.type === 'compact-commit') {
          removedQueueItems += 1;
          applyCompactCommit = true;
          continue;
        }

        removedQueueItems += 1;
        committedItems.push(item);
        if (item.message) {
          messages.push(item.message);
          committedAnyInput = true;
          continue;
        }
        if (!item.parts?.length) {
          continue;
        }

        const parts = !committedAnyInput
          ? this.prepareTurnParts(session, session.id, item.parts)
          : item.parts;
        messages.push({
          role: 'user',
          parts,
          ...(item.clientMessageId ? { __meta: { clientMessageId: item.clientMessageId } } : {}),
        });
        committedAnyInput = true;
      }

      if (removedQueueItems === 0) {
        // Keep the stop boundary and the final queue scan in one synchronous
        // section. Queue insertions before this point are passive stop inputs;
        // insertions after it see an idle session and start a new turn.
        session.stopping = false;
        await this.host.updateSessionBusyState(session, false);
        return committedMessages;
      }

      session.queue = [];
      await this.commitChildHandoffMutation(
        session,
        () => {
          for (const item of committedItems) applyChildHandoffQueueItem(session, item);
        },
        () => messages.length > 0
          ? this.host.appendQueuedSessionMessages(session, messages)
          : this.host.saveSession(session),
      );
      committedMessages += messages.length;
      if (applyCompactCommit) {
        try {
          await this.host.applyCompletedCompactJob(session.id);
        } catch (error: any) {
          logger.error({ err: error, sessionId: session.id }, 'Stop finalization failed to apply completed compact job');
          if (this.host.hasBroadcast(session)) {
            this.host.broadcast(session, `Error: ${error?.message || 'Compaction commit failed'}`);
          }
        }
      }
    }
  }

  private async tryClaimSession(session: Session): Promise<boolean> {
    if (session.busy || this.host.isSessionDestructiveLifecycleClaimed(session.id)) {
      return false;
    }

    await this.host.updateSessionBusyState(session, true);
    return true;
  }

  private async runPendingCompactionIfNeeded(
    sessionId: string,
    session: Session,
    outerQueueBoundary?: QueueItem,
  ): Promise<'continued' | false> {
    while (session.queue[0] && !isQueueItem(session.queue[0])) {
      session.queue.shift();
    }
    const nextItem = session.queue[0];
    if (nextItem === outerQueueBoundary) {
      return false;
    }
    if (nextItem?.type !== 'compact-commit') {
      return false;
    }

    session.queue.shift();

    try {
      this.host.setActiveSessionRuntimeState(sessionId, {
        state: 'requesting-model',
        since: Date.now(),
        active: { phase: 'compaction' },
      });
      await this.host.applyCompletedCompactJob(sessionId);
    } catch (e: any) {
      logger.error({ err: e, sessionId }, 'In-turn queued compaction failed');
      await this.sendSessionError(session, e);
    }

    return 'continued';
  }

  private async maybeRequestAutoCompactionBeforeContinuation(
    session: Session,
    usage: TokenUsage | undefined,
    iteration: number,
  ): Promise<void> {
    if (!usage) return;
    const currentSize = sessionManager.getUsageTotalTokens(usage);
    const compactThreshold = sessionManager.getEffectiveCompactThresholdTokens(session);
    if (currentSize <= compactThreshold) return;
    logger.info({ currentSize, compactThreshold, sessionThresholdOverride: session.compactThresholdTokens, iteration }, 'Context size exceeded threshold before turn continuation, triggering compact');
    await this.host.processSessionCompactionRequest(session.id, {
      completionMarker: 'Compaction completed. You can continue working now.',
    }, 'auto');
    logger.info('Compact requested, continuing with current history');
  }

  private async runQueuedCompaction(sessionId: string, session: Session): Promise<void> {
    try {
      this.host.setActiveSessionRuntimeState(sessionId, {
        state: 'requesting-model',
        since: Date.now(),
        active: { phase: 'compaction' },
      });
      await this.host.applyCompletedCompactJob(sessionId);
    } catch (e: any) {
      logger.error({ err: e, sessionId }, 'Queued compaction failed');
      await this.sendSessionError(session, e);
    }
  }

  private async appendUserMessage(session: Session, parts: MessagePart[], clientMessageId?: string): Promise<void> {
    await this.host.appendSessionMessage(session, {
      role: 'user',
      parts,
      ...(clientMessageId ? { __meta: { clientMessageId } } : {}),
    });
  }

  private async appendToolMessage(session: Session, parts: MessagePart[]): Promise<void> {
    await this.host.appendSessionMessage(session, {
      role: 'tool',
      parts,
    });
  }

  private async commitChildHandoffMutation(
    session: Session,
    mutate: () => void,
    commit: () => Promise<void>,
  ): Promise<void> {
    const hadState = Object.prototype.hasOwnProperty.call(session, 'childHandoffState');
    const previousState = hadState ? structuredClone(session.childHandoffState) : undefined;
    mutate();
    try {
      await commit();
    } catch (error) {
      if (!isSessionAuthorityPostCommitError(error)) {
        if (hadState) session.childHandoffState = previousState;
        else delete session.childHandoffState;
      }
      throw error;
    }
  }

  private async appendTerminalModelMessage(session: Session, text: string): Promise<void> {
    await this.host.appendSessionMessage(session, {
      role: 'model',
      parts: [{ text }],
    });
  }

  private async maybeQueueChildReminder(session: Session): Promise<void> {
    if (!session.parentSessionId || session.history.length === 0) {
      return;
    }

    const lastMessage = session.history[session.history.length - 1];
    if (lastMessage.role !== 'model' || lastMessage.parts.some(p => p.functionCall)) {
      return;
    }
    if (lastMessage.modelVisible === false) {
      return;
    }

    const terminalText = lastMessage.parts.find(p => typeof p.text === 'string')?.text || '';
    if (terminalText.startsWith('Error:')) {
      return;
    }

    if (!shouldQueueChildHandoffReminder(session) || session.queue.length > 0) {
      return;
    }

    const reminder = buildChildReminder(session.parentSessionId);
    await this.host.queueSessionSystemEvent(session.id, reminder, 'background');
  }

  private async maybeAppendGoalIntervalReminder(session: Session): Promise<void> {
    const reminder = maybeBuildGoalReminderMessage(session);
    if (!reminder) {
      return;
    }

    // Interval reminders are canonical history context for the request about to
    // be sent. They are not session work: queueing one would defer visibility
    // until after the current turn and create a synthetic reminder-only turn.
    await this.host.appendSessionMessage(session, reminder);
  }

  private async deliverIntermediateModelText(
    session: Session,
    text: string,
    broadcast: Session['broadcast'] | undefined,
    turnId: string,
  ): Promise<boolean> {
    if (!shouldBroadcastChannelText(text)) return false;
    if (this.host.deliverIntermediateText) {
      await this.host.deliverIntermediateText(session, text, turnId);
      return true;
    }
    if (!broadcast) return false;
    broadcast(text, { parse_mode: 'Markdown', excludePlatforms: ['webui'] });
    return true;
  }

  private async deliverProviderResultText(
    session: Session,
    text: string,
    willContinue: boolean,
    broadcast: Session['broadcast'] | undefined,
    turnId: string,
  ): Promise<boolean> {
    if (willContinue) {
      return this.deliverIntermediateModelText(session, text, broadcast, turnId);
    }
    if (this.host.deliverCommittedFinal) {
      if (shouldBroadcastChannelText(text)) {
        await this.host.deliverCommittedFinal(session, text, 'response', turnId);
        return true;
      }
      await this.host.deliverCommittedFinal(session, '', 'empty-final', turnId);
      return false;
    }
    if (shouldBroadcastChannelText(text)) {
      if (!broadcast) return false;
      broadcast(text, { excludePlatforms: ['webui'], turnFinal: true });
      return true;
    }
    this.sendEmptyTurnFinal(broadcast);
    return false;
  }

  private async finishTurnAfterIntermediate(
    session: Session,
    broadcast: Session['broadcast'] | undefined,
    turnId: string,
  ): Promise<void> {
    if (this.host.deliverCommittedFinal) {
      await this.host.deliverCommittedFinal(session, '', 'empty-final', turnId);
      return;
    }
    this.sendEmptyTurnFinal(broadcast);
  }

  private async sendSessionError(session: Session, error: any, broadcast: Session['broadcast'] | undefined = undefined): Promise<void> {
    const text = formatTerminalSessionError(error);
    if (broadcast) broadcast(text, { turnFinal: true });
    else if (this.host.hasBroadcast(session)) this.host.broadcast(session, text, { turnFinal: true });
  }

  private sendEmptyTurnFinal(broadcast: Session['broadcast'] | undefined): void {
    if (!broadcast) return;
    broadcast('', {
      turnFinal: true,
      allowEmptyBroadcast: true,
    });
  }


  private async runSessionTurn(
    sessionId: string,
    options: {
      parts: MessagePart[] | null;
      message?: Message;
      queuedItems?: QueueItem[];
      sourceCtx?: ChannelContext;
      sendTyping?: boolean;
      session?: Session;
      outerQueueBoundary?: QueueItem;
      onTurnOwnedRelease?: () => void;
    }
  ): Promise<'suppress-trailing-handoff' | void> {
    const session = options.session ?? await this.host.getSession(sessionId);
    if (options.parts?.length || options.message || options.queuedItems?.length) {
      sessionManager.clearSessionWaitForDirectTurn(session, options.message || options.queuedItems?.some(item => item.message) ? 'direct-message-turn' : 'direct-parts-turn');
    }
    await maybeRefreshStaleSessionSnapshot(session, this.host.refreshSessionSnapshot);

    // One ephemeral identity covers the complete provider/tool loop for this
    // invocation. A queued item consumed by this loop stays in the same turn;
    // a later runSessionTurn invocation receives a new identity.
    const turnId = randomUUID();
    const broadcast = this.host.hasBroadcast(session)
      ? (text: string, broadcastOptions?: any) => this.host.broadcast(session, text, { channelProgressTurnId: turnId, ...(broadcastOptions || {}) })
      : undefined;

    const queuedItemPartCount = options.queuedItems?.reduce(
      (count, item) => count + (item.message?.parts?.length ?? item.parts?.length ?? 0),
      0,
    );
    logger.info({ sessionId, source: options.sourceCtx ? `${getChannelId(options.sourceCtx)}:${getConversationId(options.sourceCtx)}` : 'session-event', partCount: options.message?.parts?.length ?? options.parts?.length ?? queuedItemPartCount ?? 0 }, 'Session turn processing');

    let stoppedByUser = false;
    let fencedMaintenanceError: unknown;
    let fencedMaintenanceDirect = false;
    let terminalRetryDelivered = false;
    try {
      if (options.sendTyping && options.sourceCtx) {
        await this.host.sendTyping(options.sourceCtx);
      }
      let managedStepYieldReason: 'tool' | null = null;
      let parts = options.message
        ? null
        : options.parts === null
          ? null
          : this.prepareTurnParts(
            session,
            sessionId,
            options.parts || []
          );
      if (options.message) {
        await this.host.appendSessionMessage(session, options.message);
      }
      let queuedItems = options.queuedItems;
      let iteration = 0;
      let finalUsage: TokenUsage | undefined;
      while (iteration < 500) {
        const pendingCompaction = await this.runPendingCompactionIfNeeded(sessionId, session, options.outerQueueBoundary);
        if (pendingCompaction === 'continued') {
          continue;
        }

        if (queuedItems?.length) {
          // Keep a drained batch unsent across the pre-LLM compaction safe
          // point. Once that boundary is clear, persist its individual queue
          // records before consuming any additional follow-ups.
          await this.appendQueuedTurnInputs(session, sessionId, queuedItems);
          queuedItems = undefined;
          parts = null;
        }

        const queuedBeforeLlm = await this.consumeLeadingQueuedTurnInputs(session, parts);
        parts = queuedBeforeLlm.parts;

        if (session.stopping) {
          logger.info({ sessionId: session.id }, 'Session stopping flag detected, halting tool call loop');
          stoppedByUser = true;
          await this.host.saveSession(session);
          await this.deliverProviderResultText(
            session, '_[Execution stopped by user]_', false, broadcast, turnId,
          );
          break;
        }

        // This is the safe boundary immediately before a provider call: queued
        // inputs and the preceding tool result have already been persisted, so
        // an interval reminder cannot split a function call from its result.
        await this.maybeAppendGoalIntervalReminder(session);

        await this.emitTurnProgress({ type: 'llm-start' }, session, turnId);
        this.host.setActiveSessionRuntimeState(session.id, {
          state: 'requesting-model',
          since: Date.now(),
          active: {
            iteration,
            phase: 'normal-turn',
          },
        });

        let result;
        try {
          result = await this.host.chat(parts, session, iteration, {
            onRetry: this.createLlmRetryNotifier(session, broadcast, turnId, () => { terminalRetryDelivered = true; }),
            turnId,
          });
        } catch (e: any) {
          if (session.stopping && llm.isAbortError(e)) {
            logger.info({ sessionId: session.id }, 'In-flight LLM request aborted by stop signal');
            stoppedByUser = true;
            await this.host.saveSession(session);
            await this.deliverProviderResultText(
              session, '_[Execution stopped by user]_', false, broadcast, turnId,
            );
            break;
          }
          throw e;
        }

        // llm.chat appends non-null parts to canonical history before returning.
        // Keep only unsent inputs across a pre-LLM compact boundary; otherwise a
        // compact commit between tool iterations would replay this turn's user
        // input in the next provider request.
        parts = null;
        finalUsage = result.usage;

        if (result.usage) {
          session.stats.lastUsage = result.usage;
        }

        // A Worker turn cannot accept a second runPending call while this turn
        // owns the serial lane. Pull newly durable mailbox inputs at this safe
        // point so follow-ups received during the provider request
        // participate in the same canonical runner semantics as local queues.
        await this.host.ingestPendingQueue?.(session);
        // Dequeue may arrive while the awaited Worker ingestion is publishing
        // its newly hot queue. Do not fold those rows into the current provider
        // result after the stop override has claimed them for the outer loop.
        const stopOverrideAfterProviderIngest = !!session.meta?.runQueuedAfterStop;
        const providerTimeQueue = stopOverrideAfterProviderIngest
          ? false
          : this.inspectLeadingQueuedTurnInputs(session);
        // Decide this result's finality from a non-mutating queue view. Queue
        // rows append only after this text and, for tools, after the tool row.
        const hasTools = !!result.toolCalls?.length;
        const willContinue = hasTools || providerTimeQueue;
        if (!willContinue && isNoActionSignalText(result.text) && resolveChildHandoffBoundary(session)) {
          await this.host.saveSession(session);
        }
        const iterationTextHandled = await this.deliverProviderResultText(
          session,
          result.text,
          willContinue,
          broadcast,
          turnId,
        );

        if (!hasTools) {
          if (providerTimeQueue) {
            const queuedAfterLlm = await this.consumeLeadingQueuedTurnInputs(session, null);
            if (!queuedAfterLlm.consumedInput) {
              await this.finishTurnAfterIntermediate(session, broadcast, turnId);
              break;
            }
            await this.maybeRequestAutoCompactionBeforeContinuation(session, result.usage, iteration);
            iteration++;
            continue;
          }
          break;
        }

        const turnToolCalls = this.getTurnToolCalls(result.toolCalls!, iteration);

        await this.emitTurnProgress({
          type: 'tool-calls-start',
          calls: turnToolCalls.map(call => ({ id: call.id, name: call.name })),
        }, session, turnId);

        this.host.setActiveSessionRuntimeState(session.id, {
          state: 'running-tool',
          since: Date.now(),
          active: {
            iteration,
            phase: 'normal-turn',
          },
          tool: {
            id: turnToolCalls[0]?.id,
            name: turnToolCalls[0]?.name || 'tool',
            index: 0,
            total: turnToolCalls.length,
            startedAt: Date.now(),
          },
        });

        const toolContext = {
          sessionId: session.id,
          session,
          previousLlmRequest: result.previousLlmRequest,
          broadcast,
          onToolStart: (tool: { id?: string; name: string; index?: number; total?: number; executionNode?: string; argsPreview?: string; startedAt?: number }) => {
            this.host.setActiveSessionRuntimeState(session.id, {
              state: 'running-tool',
              since: tool.startedAt || Date.now(),
              active: {
                iteration,
                phase: 'normal-turn',
              },
              tool: {
                id: tool.id,
                name: tool.name,
                index: tool.index,
                total: tool.total,
                executionNode: tool.executionNode,
                argsPreview: tool.argsPreview,
                startedAt: tool.startedAt || Date.now(),
              },
            });
          },
        };
        const toolResultMsg = await this.host.executeTools(turnToolCalls, toolContext, session);

        const successfulSendTargets = (toolResultMsg as any).__toolPostAction?.successfulSendToSessionTargets;
        if (session.parentSessionId && Array.isArray(successfulSendTargets)
          && successfulSendTargets.includes(session.parentSessionId)
          && resolveChildHandoffBoundary(session)) {
          await this.host.saveSession(session);
        }

        await this.appendToolMessage(session, toolResultMsg.parts);
        await this.emitTurnProgress({
          type: 'tool-calls-finish',
          results: this.getToolResultProgress(toolResultMsg),
        }, session, turnId);

        const fatalToolError = (toolResultMsg as any).__toolLoopControl?.fatalError;
        if (fatalToolError && typeof fatalToolError.code === 'string' && typeof fatalToolError.message === 'string') {
          const error = new Error(fatalToolError.message) as Error & { code?: string };
          error.code = fatalToolError.code;
          throw error;
        }

        const waitForReply = (toolResultMsg as any).__toolPostAction?.waitForReply === true;
        if (waitForReply && !session.stopping && !session.meta?.wait) {
          const targets = (toolResultMsg as any).__toolPostAction?.successfulWaitAfterSendTargets;
          const resolvedTargets = Array.isArray(targets)
            ? [...new Set(targets.filter((target: unknown): target is string => typeof target === 'string' && !!target))]
            : [];
          const wait = await this.host.startSessionWait(session, resolvedTargets.length
            ? { waitAnySessions: resolvedTargets, declarationVersion: 1 }
            : { waitForInput: true, declarationVersion: 1 });
          if (resolvedTargets.length) await armMainWaitLiveness({ sourceSessionId: session.id, waitId: wait.id });
        }

        const managedStateAfterTools = getManagedSessionState(session);
        if (managedStateAfterTools?.currentStep?.runMode === 'tool') {
          managedStateAfterTools.lastStepResult = {
            stepId: managedStateAfterTools.currentStep.stepId,
            yieldReason: 'tool',
            yieldedAt: Date.now(),
          };
          setManagedSessionState(session, managedStateAfterTools);
          managedStepYieldReason = 'tool';
          await this.finishTurnAfterIntermediate(session, broadcast, turnId);
          break;
        }

        if (session.stopping) {
          logger.info({ sessionId: session.id, iteration }, 'Session stopping flag detected after tool execution, halting tool call loop');
          stoppedByUser = true;
          await this.host.saveSession(session);
          // Preserve the existing Stop annotation only when this iteration had
          // no non-empty model text to handle. This flag is iteration-local;
          // it never participates in ordinary final-response suppression.
          if (iterationTextHandled) {
            await this.finishTurnAfterIntermediate(session, broadcast, turnId);
          } else {
            await this.deliverProviderResultText(
              session, '_[Execution stopped by user]_', false, broadcast, turnId,
            );
          }
          break;
        }

        if ((toolResultMsg as any).__toolLoopControl?.stopCurrentTurn) {
          logger.info({ sessionId: session.id, iteration }, 'Tool requested immediate turn stop');
          await this.finishTurnAfterIntermediate(session, broadcast, turnId);
          break;
        }

        if (waitForReply) {
          logger.info({ sessionId: session.id, iteration }, 'Successful handoff requested an activity wait');
          await this.finishTurnAfterIntermediate(session, broadcast, turnId);
          break;
        }

        const compactionAfterTools = await this.runPendingCompactionIfNeeded(sessionId, session, options.outerQueueBoundary);
        if (compactionAfterTools === 'continued') {
          iteration++;
          continue;
        }

        await this.host.ingestPendingQueue?.(session);
        // This is the second ingestion-to-consume boundary in a tool
        // iteration. Dequeue can signal while the awaited ingestion is in
        // flight; recheck before inspecting or consuming compatible rows so
        // turn finalization clears the override and the same outer busy claim
        // selects those rows exactly once.
        if (session.meta?.runQueuedAfterStop) {
          stoppedByUser = true;
          await this.host.saveSession(session);
          if (iterationTextHandled) {
            await this.finishTurnAfterIntermediate(session, broadcast, turnId);
          } else {
            await this.deliverProviderResultText(
              session, '_[Execution stopped by user]_', false, broadcast, turnId,
            );
          }
          break;
        }
        const queuedAfterTools = await this.consumeLeadingQueuedTurnInputs(session, null);
        parts = queuedAfterTools.parts;

        await this.maybeRequestAutoCompactionBeforeContinuation(session, result.usage, iteration);

        iteration++;
      }

      if (iteration >= 500) {
        await this.deliverProviderResultText(
          session,
          'Error: Too many tool call iterations',
          false,
          broadcast,
          turnId,
        );
      }

      const managedStateAfterTurn = getManagedSessionState(session);
      if (managedStateAfterTurn?.currentStep && !managedStepYieldReason) {
        managedStateAfterTurn.lastStepResult = {
          stepId: managedStateAfterTurn.currentStep.stepId,
          yieldReason: 'idle',
          yieldedAt: Date.now(),
        };
        setManagedSessionState(session, managedStateAfterTurn);
      }

      try {
        await this.maybeQueueChildReminder(session);
      } catch (error) {
        // A terminal provider result has already made its one external final
        // attempt. Child-reminder queueing is post-final maintenance: retain
        // the underlying persistence/resync result, but never turn its failure
        // into a synthetic model row or a second external final.
        logger.error({ err: error, sessionId }, 'Post-final child reminder queueing failed');
      }
      if (!stoppedByUser) {
        await this.host.checkAndCompactIfNeeded(sessionId, finalUsage);
      }
    } catch (e: any) {
      logger.error(e, 'Error handling message');
      const errorText = formatTerminalSessionError(e);
      const mutationFencedMaintenance = e?.code === 'SESSION_WORKER_AUTO_COMPACTION_FATAL';
      const archiveCommitFailure = isSessionArchiveCommitError(e);
      if (archiveCommitFailure) {
        // The required archive boundary already restored/resynced the owner.
        // Do not try to append another semantic error row through the same
        // failed archive. Make at most one presentation-only final attempt.
        if (this.host.deliverCommittedFinal) {
          await this.host.deliverCommittedFinal(session, errorText, 'error', turnId);
        } else {
          await this.sendSessionError(session, e, broadcast);
        }
        return 'suppress-trailing-handoff';
      }
      if (mutationFencedMaintenance) {
        fencedMaintenanceError = e;
        if (this.host.deliverCommittedFinal) {
          fencedMaintenanceDirect = true;
          await this.host.deliverCommittedFinal(session, errorText, 'error', turnId);
          return;
        }
      } else if (!llm.isLlmRequestError(e)) {
        await this.appendTerminalModelMessage(session, errorText);
      }
      if (!mutationFencedMaintenance && this.host.deliverCommittedFinal
        && !(llm.isLlmRequestError(e) && terminalRetryDelivered)) {
        await this.maybeQueueChildReminder(session);
        await this.host.deliverCommittedFinal(session, errorText, 'error', turnId);
        return;
      }
      if (mutationFencedMaintenance) {
        // Source-less fenced maintenance must surface after the exact release
        // attempt without entering any generic history/reminder/send branch.
      } else if (llm.isLlmRequestError(e)) {
        await this.maybeQueueChildReminder(session);
        if (terminalRetryDelivered) {
          // The awaited retry callback already made the one terminal Channel
          // delivery and finalized native lifecycle presentation.
        } else if (this.host.hasBroadcast(session)) {
          this.sendEmptyTurnFinal(broadcast);
        } else {
          await this.sendSessionError(session, e, broadcast);
        }
      } else {
        await this.maybeQueueChildReminder(session);
        await this.sendSessionError(session, e, broadcast);
      }
    } finally {
      try { await this.host.finishChannelProgress?.(session, turnId); }
      catch (error) { logger.warn({ err: error, sessionId, turnId }, 'Channel progress cleanup failed'); }
      if (fencedMaintenanceError) {
        options.onTurnOwnedRelease?.();
        try { await this.host.updateSessionBusyState(session, false); }
        catch (releaseError) { if (fencedMaintenanceDirect) throw releaseError; throw fencedMaintenanceError; }
        if (!fencedMaintenanceDirect) throw fencedMaintenanceError;
        return 'suppress-trailing-handoff';
      }
      // Worker ingress can become durable while a provider/tool phase is in
      // flight. Both Stop and Dequeue ingest at this exact boundary: Stop
      // passively commits the exact prefix accepted before its atomic boundary,
      // while Dequeue leaves that prefix queued for the same outer action loop.
      if (stoppedByUser || session.stopping || session.meta?.runQueuedAfterStop) {
        await this.host.ingestPendingQueue?.(session);
      }
      const runQueuedAfterStop = !!session.meta?.runQueuedAfterStop;
      if (session.meta?.runQueuedAfterStop) {
        delete session.meta.runQueuedAfterStop;
      }
      const stopCompleted = stoppedByUser || !!session.stopping;

      if (stopCompleted && !runQueuedAfterStop) {
        options.onTurnOwnedRelease?.();
        await this.finalizeStoppedSession(session);
        return;
      }
      if (session.stopping) {
        session.stopping = false;
      }
    }
  }

  async processSessionRetry(sessionId: string): Promise<void> {
    await this.processSessionQueue(sessionId, { retry: true });
  }

  async processSessionQueue(sessionId: string, options: { retry?: boolean } = {}): Promise<void> {
    if (this.processingSessions.has(sessionId)) {
      if (options.retry) {
        throw new Error('Session is already busy');
      }
      return;
    }

    this.processingSessions.add(sessionId);
    let session: Session | null = null;
    let claimed = false;
    let outerOwnsBusyRelease = true;
    let failed = false;
    let suppressTrailingHandoff = false;
    try {
      session = await this.host.getExistingSession(sessionId);
      if (!session) {
        return;
      }
      if (options.retry) {
        if (buildSessionRuntimeState(session).state === 'waiting') {
          throw new SessionContinuationUnavailableError('Session is waiting and cannot be continued manually.');
        }
        if (!isSessionTurnIncomplete(session.history)) {
          throw new SessionContinuationUnavailableError();
        }
      }
      if (!await this.tryClaimSession(session)) {
        if (options.retry) {
          throw new Error('Session is already busy');
        }
        return;
      }
      claimed = true;

      let retryPending = options.retry === true;
      while (session.busy && !suppressTrailingHandoff) {
        if (retryPending) {
          retryPending = false;
          const outcome = await this.runSessionTurn(sessionId, {
            parts: null,
            session,
            onTurnOwnedRelease: () => { outerOwnsBusyRelease = false; },
          });
          suppressTrailingHandoff = outcome === 'suppress-trailing-handoff';
          continue;
        }

        const managed = getManagedSessionState(session);
        if (managed?.currentStep && managed.lastStepResult?.stepId === managed.currentStep.stepId) {
          break;
        }

        while (session.queue[0] && !isQueueItem(session.queue[0])) {
          session.queue.shift();
        }
        if (session.queue.length === 0) {
          break;
        }

        // Preserve the durable queue before selecting the next owned action.
        // The selected compact or ordinary turn then commits its own mutation.
        await this.host.saveSession(session);

        if (session.queue[0]?.type === 'compact-commit') {
          session.queue.shift();
          await this.runQueuedCompaction(sessionId, session);
          continue;
        }

        const queuedItems = this.drainLeadingQueuedTurnInputs(session);
        if (queuedItems.length === 0) {
          break;
        }
        const outcome = await this.runSessionTurn(sessionId, {
          parts: null,
          queuedItems,
          session,
          ...(session.queue[0] ? { outerQueueBoundary: session.queue[0] } : {}),
          onTurnOwnedRelease: () => { outerOwnsBusyRelease = false; },
        });
        suppressTrailingHandoff = outcome === 'suppress-trailing-handoff';
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (claimed && outerOwnsBusyRelease && session?.busy) {
          await this.host.updateSessionBusyState(session, false);
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        this.processingSessions.delete(sessionId);
        // An item can become visible after the outer loop's final queue scan
        // but before this processor releases its guard. Hand that finish-window
        // work to exactly one fresh processor after ownership is idle.
        session = await this.host.getExistingSession(sessionId);
        if (claimed
          && !failed
          && !suppressTrailingHandoff
          && session
          && !session.busy
          && !getManagedSessionState(session)?.currentStep
          && !this.host.isSessionDestructiveLifecycleClaimed(session.id)
          && session.queue.some(isQueueItem)) {
          void this.processSessionQueue(sessionId).catch(error => {
            logger.error({ err: error, sessionId }, 'Trailing queued work failed');
          });
        }
      }
    }
  }
}
