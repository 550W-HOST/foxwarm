/** Canonical per-session queue and turn state machine. */

import { randomUUID } from 'crypto';
import { logger } from './common';
import { ChannelContext, getChannelId, getConversationId } from './channel';
import { buildChildReminder, isModelNoActionSignal, isNoActionSignalText } from './session/childSessionReminder';
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
import * as llm from './llm';
import { ChannelTurnProgress, ChannelTurnToolResult, FunctionCall, isQueueItem, Message, MessagePart, QueueItem, QueueSource, Session, TokenUsage } from './types';
import { formatFoxwarmSystemTag, parseFoxwarmOpeningTag } from './utils/promptWrappers';

export function shouldBroadcastChannelText(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

export function formatTerminalSessionError(error: any): string {
  return llm.isLlmRequestError(error)
    ? `⚠️ LLM request failed: ${error?.message || 'Unknown error'}`
    : `Error: ${error?.message || 'Unknown error'}`;
}

type SourceMergeBoundary = {
  streamKey?: string;
  preferDirectReply: boolean;
};

function formatRetryDelay(delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function formatRetryStatus(event: llm.LlmRetryEvent, initial: boolean): string {
  const statusPrefix = event.status ? `${event.status}: ` : '';
  const reason = `${statusPrefix}${event.reason}`.trim();
  const retryText = event.final
    ? 'No more retries.'
    : `Retry in ${formatRetryDelay(event.delayMs || 0)}...`;
  const attemptText = reason
    ? `Attempt ${event.attempt}/${event.maxRetries} failed: ${reason}. ${retryText}`
    : `Attempt ${event.attempt}/${event.maxRetries} failed. ${retryText}`;
  if (initial) {
    return `⚠️ [LLM retry]\n${attemptText}`;
  }

  return `\n${attemptText}`;
}

function formatRetryChannelSnippet(event: llm.LlmRetryEvent): string {
  const statusPrefix = event.status ? `${event.status}: ` : '';
  const reason = `${statusPrefix}${event.reason}`.trim();
  const retryText = event.final
    ? 'No more retries.'
    : `Retry in ${formatRetryDelay(event.delayMs || 0)}...`;
  const failureText = reason
    ? `Attempt ${event.attempt}/${event.maxRetries} failed: ${reason}.`
    : `Attempt ${event.attempt}/${event.maxRetries} failed.`;
  return `⚠️ [LLM retry]\n${failureText}\n${retryText}`;
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
  sendSessionReply(session: Session, sourceCtx: ChannelContext | undefined, text: string, options?: any, preferDirectReply?: boolean): Promise<void>;
  ingestPendingQueue?(session: Session): Promise<void>;
  deliverIntermediateText?(session: Session, source: QueueSource, text: string): Promise<void>;
  deliverCommittedFinal?(session: Session, source: QueueSource, text: string, outcome: SessionTurnFinalKind): Promise<void>;
}

export type LocalSessionTurnHostOverrides = Partial<Pick<SessionTurnHost,
  'applyCompletedCompactJob' | 'processSessionCompactionRequest' | 'checkAndCompactIfNeeded'
  | 'queueSessionSystemEvent' | 'refreshSessionSnapshot' | 'ingestPendingQueue' | 'deliverIntermediateText' | 'deliverCommittedFinal'>>;

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
      notifySessionEvent: bind(effects.notifySessionEvent),
      registerAbortController: bind(effects.registerAbortController),
      clearAbortController: bind(effects.clearAbortController),
      clearWaitById: bind(effects.clearWaitById),
      ...(effects.execRuntime ? { execRuntime: effects.execRuntime } : {}),
      appendMessages: turnEffects.appendMessages
        ? bind(turnEffects.appendMessages)
        : ((session, messages) => sessionManager.appendSessionMessagesForSession(
          session, messages, () => effects.persistSession(session), notifyHistoryUpdate,
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
  hasBroadcast(session: Session): boolean { this.assertOwnerSession(session); return !!session.broadcast; }
  broadcast(session: Session, text: string, options?: any): void { this.assertOwnerSession(session); session.broadcast?.(text, options); }

  async sendSessionReply(session: Session, sourceCtx: ChannelContext | undefined, text: string, options?: any, preferDirectReply = false): Promise<void> {
    this.assertOwnerSession(session);
    if (preferDirectReply && sourceCtx?.reply) {
      await sourceCtx.reply(text, options);
      return;
    }
    if (session.broadcast) {
      session.broadcast(text, options);
      return;
    }
    if (sourceCtx?.reply) await sourceCtx.reply(text, options);
  }
}

export class SessionTurnRunner {
  private processingSessions: Set<string> = new Set();

  constructor(private readonly host: SessionTurnHost) {}

  snapshotSource(ctx: ChannelContext): QueueSource {
    return snapshotQueueSource(ctx);
  }

  private getSourceStreamKey(source?: QueueSource): string | undefined {
    if (source?.weworkStreamId) return `wework:${source.channelId || source.platform}:${source.conversationId || source.channelUserId}`;
    if (source?.qqbotMessageId) return `qqbot:${source.channelId || source.platform}:${source.conversationId || source.channelUserId}`;
    return undefined;
  }

  private getSourceMergeBoundary(source?: QueueSource): SourceMergeBoundary {
    return {
      streamKey: this.getSourceStreamKey(source),
      preferDirectReply: source?.preferDirectReply === true,
    };
  }

  private getTurnChannelOptions(sourceCtx?: ChannelContext, source?: QueueSource): Record<string, any> {
    const streamId = sourceCtx?.weworkStreamId || source?.weworkStreamId;
    const channelId = sourceCtx ? getChannelId(sourceCtx) : (source?.channelId || source?.platform);
    const conversationId = sourceCtx ? getConversationId(sourceCtx) : (source?.conversationId || source?.channelUserId);
    const options: Record<string, any> = {};
    if (streamId) {
      options.weworkStreamId = streamId;
      if (channelId && conversationId) {
        options.weworkStreamChannelId = channelId;
        options.weworkStreamConversationId = conversationId;
      }
    }
    const qqbotMessageId = sourceCtx?.qqbotMessageId || source?.qqbotMessageId;
    if (qqbotMessageId && channelId && conversationId) {
      options.qqbotMessageId = qqbotMessageId;
      options.qqbotChannelId = channelId;
      options.qqbotConversationId = conversationId;
    }
    return options;
  }

  private mergeTurnOptions(turnOptions: Record<string, any>, options?: any): any {
    return Object.keys(turnOptions).length > 0
      ? { ...turnOptions, ...(options || {}) }
      : options;
  }

  private getTurnTargetChannel(turnOptions: Record<string, any>): { channelId: string; conversationId: string } | undefined {
    if (!turnOptions.weworkStreamChannelId || !turnOptions.weworkStreamConversationId) {
      return undefined;
    }
    return {
      channelId: turnOptions.weworkStreamChannelId,
      conversationId: turnOptions.weworkStreamConversationId,
    };
  }

  private emitTurnProgress(
    broadcast: Session['broadcast'] | undefined,
    turnOptions: Record<string, any>,
    progress: ChannelTurnProgress,
  ): void {
    if (!broadcast || !turnOptions.weworkStreamId) {
      return;
    }
    broadcast('', {
      allowEmptyBroadcast: true,
      channelTurnProgress: progress,
      ...(this.getTurnTargetChannel(turnOptions) ? { targetChannel: this.getTurnTargetChannel(turnOptions) } : {}),
    });
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

  private buildToolBroadcast(broadcast: Session['broadcast'] | undefined, turnOptions: Record<string, any>): Session['broadcast'] | undefined {
    if (!broadcast || !turnOptions.weworkStreamChannelId) {
      return broadcast;
    }
    return (text: string, options?: any) => {
      const excludePlatforms = Array.from(new Set([...(options?.excludePlatforms || []), turnOptions.weworkStreamChannelId]));
      broadcast(text, { ...(options || {}), excludePlatforms });
    };
  }

  private createLlmRetryNotifier(
    session: Session,
    broadcast: Session['broadcast'] | undefined,
    getCurrentTurnChannelOptions: () => Record<string, any> = () => ({}),
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

      if (!broadcast) return;

      const channelSnippet = formatRetryChannelSnippet(displayEvent);
      const channelOptions = getCurrentTurnChannelOptions();
      const targetChannel = this.getTurnTargetChannel(channelOptions);
      if (initial || event.final === true) {
        // The ordinary broadcast is intentionally sent only for the first
        // attempt and terminal failure. Its existing turn binding naturally
        // includes an active WeWork stream when one is present.
        broadcast(channelSnippet, mergeExcludePlatforms({ parse_mode: 'Markdown' }, ['webui']));
      } else if (channelOptions.weworkStreamId && targetChannel) {
        // Intermediate retry updates are meaningful only for the active
        // WeWork stream-card target. Avoid sending them to every attached
        // non-streaming channel.
        this.host.broadcast(session, channelSnippet, {
          ...channelOptions,
          parse_mode: 'Markdown',
          excludePlatforms: ['webui'],
          targetChannel,
        });
      }
    };
  }

  async sendSessionReply(session: Session, sourceCtx: ChannelContext | undefined, text: string, options?: any, source?: QueueSource): Promise<void> {
    const effectiveSource = source ?? (sourceCtx ? this.snapshotSource(sourceCtx) : undefined);
    await this.host.sendSessionReply(session, sourceCtx, text, options, effectiveSource?.preferDirectReply === true);
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

  private drainLeadingQueuedTurnInputs(session: Session): { items: QueueItem[]; broadcastSource?: QueueSource } {
    const items: QueueItem[] = [];
    let broadcastSource: QueueSource | undefined;
    let sourceBoundary: SourceMergeBoundary | undefined;

    while (session.queue[0]) {
      if (!isQueueItem(session.queue[0])) {
        session.queue.shift();
        continue;
      }
      if (session.queue[0].type === 'compact-commit') {
        break;
      }
      const nextBoundary = this.getSourceMergeBoundary(session.queue[0].source);
      if (sourceBoundary
        && (sourceBoundary.streamKey !== nextBoundary.streamKey
          || sourceBoundary.preferDirectReply !== nextBoundary.preferDirectReply)) {
        break;
      }
      const item = session.queue.shift();
      if (!item) continue;
      if (!item.message && !item.parts?.length) continue;

      if (items.length === 0) {
        broadcastSource = item.source;
        sourceBoundary = nextBoundary;
      }

      items.push(item);
    }

    return { items, broadcastSource };
  }

  private async consumeLeadingQueuedTurnInputs(
    session: Session,
    pendingParts: MessagePart[] | null,
    turnBoundary: SourceMergeBoundary,
  ): Promise<{ parts: MessagePart[] | null; consumedInput: boolean }> {
    let parts = pendingParts;
    let consumedInput = false;

    while (session.queue[0]) {
      if (!isQueueItem(session.queue[0])) {
        session.queue.shift();
        continue;
      }
      if (session.queue[0].type === 'compact-commit') {
        break;
      }
      const queuedBoundary = this.getSourceMergeBoundary(session.queue[0].source);
      // A different passive-source conversation or final-delivery intent owns
      // a separate turn. Message/card IDs within one conversation do not.
      if (queuedBoundary.preferDirectReply !== turnBoundary.preferDirectReply
        || (queuedBoundary.streamKey && queuedBoundary.streamKey !== turnBoundary.streamKey)) {
        break;
      }

      const item = session.queue.shift();
      if (!item) {
        continue;
      }

      // Queue entries are canonical history boundaries. Flush the current
      // unsent turn before recording a follow-up, rather than concatenating
      // their parts into one user message. Provider serializers are the only
      // layer that may normalize adjacent same-role messages for a protocol.
      if (!consumedInput && parts?.length) {
        await this.appendUserMessage(session, parts);
        parts = null;
      }

      if (item.message) {
        consumedInput = true;
        await this.appendQueueItemMessage(session, item, () => this.host.appendSessionMessage(session, item.message!));
        continue;
      }

      if (!item.parts?.length) {
        continue;
      }

      consumedInput = true;
      await this.appendQueueItemMessage(
        session,
        item,
        () => this.appendUserMessage(session, item.parts!, item.clientMessageId),
      );
    }

    return {
      parts,
      consumedInput,
    };
  }

  private inspectLeadingCompatibleQueuedTurnInputs(
    session: Session,
    turnBoundary: SourceMergeBoundary,
  ): { hasInput: boolean; latestSource?: QueueSource } {
    let hasInput = false;
    let latestSource: QueueSource | undefined;
    for (const item of session.queue) {
      if (!isQueueItem(item)) continue;
      if (item.type === 'compact-commit') break;
      const queuedBoundary = this.getSourceMergeBoundary(item.source);
      if (queuedBoundary.preferDirectReply !== turnBoundary.preferDirectReply
        || (queuedBoundary.streamKey && queuedBoundary.streamKey !== turnBoundary.streamKey)) break;
      if (!item.message && !item.parts?.length) continue;
      hasInput = true;
      if (item.source) latestSource = item.source;
    }
    return { hasInput, latestSource };
  }

  private async appendQueuedTurnInputs(session: Session, sessionId: string, items: QueueItem[]): Promise<void> {
    let firstInputItem = true;
    for (const item of items) {
      if (item.message) {
        await this.appendQueueItemMessage(session, item, () => this.host.appendSessionMessage(session, item.message!));
        firstInputItem = false;
        continue;
      }
      if (!item.parts?.length) {
        continue;
      }

      // Only the first input item starts this turn, so it receives turn metadata.
      // Every queued item is still persisted as its own canonical message.
      const parts = firstInputItem
        ? this.prepareTurnParts(session, sessionId, item.parts)
        : item.parts;
      await this.appendQueueItemMessage(
        session,
        item,
        () => this.appendUserMessage(session, parts, item.clientMessageId),
      );
      firstInputItem = false;
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
          ? this.host.appendSessionMessages(session, messages)
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
      await this.sendSessionError(session, undefined, e);
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
      await this.sendSessionError(session, undefined, e);
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

  private appendQueueItemMessage(session: Session, item: QueueItem, append: () => Promise<void>): Promise<void> {
    return this.commitChildHandoffMutation(
      session,
      () => { applyChildHandoffQueueItem(session, item); },
      append,
    );
  }

  private getChildTurnState(session: Session): {
    foundUser: boolean;
    hasSendToSession: boolean;
    hasNoAction: boolean;
    hasUserFromPrefix: boolean;
  } {
    const history = session.history;
    let idx = history.length - 1;
    let foundUser = false;
    let hasSendToSession = false;
    let hasNoAction = false;
    let hasUserFromPrefix = false;

    while (idx >= 0) {
      const msg = history[idx];
      if (isModelNoActionSignal(msg)) {
        hasNoAction = true;
      }
      if (msg.parts?.some(p => {
        if (typeof p.system !== 'string') {
          return false;
        }
        if (p.system.startsWith('FROM:') || p.system.startsWith('The following message is a direct user message via channel;')) {
          return true;
        }
        const tag = parseFoxwarmOpeningTag(p.system);
        return tag?.tagName === 'foxwarm-message' && tag.attrs.type === 'channel';
      })) {
        hasUserFromPrefix = true;
      }
      if (msg.role === 'user') {
        foundUser = true;
        break;
      }
      if (msg.parts?.some(p => p.functionCall?.name === 'send_to_session')) {
        hasSendToSession = true;
      }
      idx--;
    }

    return {
      foundUser,
      hasSendToSession,
      hasNoAction,
      hasUserFromPrefix,
    };
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

    const stateDecision = shouldQueueChildHandoffReminder(session);
    if (stateDecision !== undefined) {
      if (stateDecision && session.queue.length === 0) {
        const reminder = buildChildReminder(session.parentSessionId);
        await this.host.queueSessionSystemEvent(session.id, reminder, 'background');
      }
      return;
    }

    const { foundUser, hasSendToSession, hasNoAction, hasUserFromPrefix } = this.getChildTurnState(session);

    if (foundUser && !hasNoAction && !hasSendToSession && !hasUserFromPrefix && session.queue.length === 0) {
      const reminder = buildChildReminder(session.parentSessionId);
      await this.host.queueSessionSystemEvent(session.id, reminder, 'background');
    }
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
    source: QueueSource | undefined,
    text: string,
    broadcast: Session['broadcast'] | undefined,
    turnOptions: Record<string, any>,
  ): Promise<boolean> {
    if (!shouldBroadcastChannelText(text)) return false;
    if (source && this.host.deliverIntermediateText) {
      await this.host.deliverIntermediateText(session, source, text);
      return true;
    }
    if (!broadcast) return false;
    const excludePlatforms = Array.from(new Set([
      'webui',
      ...(turnOptions.weworkStreamChannelId ? [turnOptions.weworkStreamChannelId] : []),
    ]));
    broadcast(text, { parse_mode: 'Markdown', excludePlatforms });
    return true;
  }

  private async deliverProviderResultText(
    session: Session,
    sourceCtx: ChannelContext | undefined,
    source: QueueSource | undefined,
    text: string,
    willContinue: boolean,
    broadcast: Session['broadcast'] | undefined,
    turnOptions: Record<string, any>,
  ): Promise<boolean> {
    if (willContinue) {
      return this.deliverIntermediateModelText(session, source, text, broadcast, turnOptions);
    }
    if (source && this.host.deliverCommittedFinal) {
      if (shouldBroadcastChannelText(text)) {
        await this.host.deliverCommittedFinal(session, source, text, 'response');
        return true;
      }
      if (source.weworkStreamId) {
        await this.host.deliverCommittedFinal(session, source, '', 'empty-final');
      }
      return false;
    }
    if (shouldBroadcastChannelText(text)) {
      await this.sendSessionReply(
        session,
        sourceCtx,
        text,
        this.mergeTurnOptions(turnOptions, { excludePlatforms: ['webui'], turnFinal: true }),
        source,
      );
      return true;
    }
    this.sendEmptyTurnFinal(broadcast, turnOptions);
    return false;
  }

  private async finishTurnAfterIntermediate(
    session: Session,
    source: QueueSource | undefined,
    broadcast: Session['broadcast'] | undefined,
    turnOptions: Record<string, any>,
  ): Promise<void> {
    if (source?.weworkStreamId && this.host.deliverCommittedFinal) {
      await this.host.deliverCommittedFinal(session, source, '', 'empty-final');
      return;
    }
    this.sendEmptyTurnFinal(broadcast, turnOptions);
  }

  private async sendSessionError(session: Session, sourceCtx: ChannelContext | undefined, error: any, turnOptions?: Record<string, any>, source?: QueueSource): Promise<void> {
    const text = formatTerminalSessionError(error);
    await this.sendSessionReply(session, sourceCtx, text, this.mergeTurnOptions(turnOptions || {}, { turnFinal: true }), source);
  }

  private sendEmptyTurnFinal(broadcast: Session['broadcast'] | undefined, turnOptions: Record<string, any>): void {
    if (!turnOptions.weworkStreamId || !broadcast) {
      return;
    }
    broadcast('', {
      turnFinal: true,
      allowEmptyBroadcast: true,
      ...(this.getTurnTargetChannel(turnOptions) ? { targetChannel: this.getTurnTargetChannel(turnOptions) } : {}),
    });
  }


  private async runSessionTurn(
    sessionId: string,
    options: {
      parts: MessagePart[] | null;
      message?: Message;
      queuedItems?: QueueItem[];
      sourceCtx?: ChannelContext;
      source?: QueueSource;
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

    let turnSource = options.source ?? (options.sourceCtx ? this.snapshotSource(options.sourceCtx) : undefined);
    // One ephemeral identity covers the complete provider/tool loop for this
    // invocation. A queued item consumed by this loop stays in the same turn;
    // a later runSessionTurn invocation receives a new identity.
    const turnId = randomUUID();
    let turnChannelOptions = this.getTurnChannelOptions(undefined, turnSource);
    const turnBoundary = this.getSourceMergeBoundary(turnSource);
    const broadcast = this.host.hasBroadcast(session)
      ? (text: string, broadcastOptions?: any) => this.host.broadcast(session, text, this.mergeTurnOptions(turnChannelOptions, broadcastOptions))
      : undefined;

    const queuedItemPartCount = options.queuedItems?.reduce(
      (count, item) => count + (item.message?.parts?.length ?? item.parts?.length ?? 0),
      0,
    );
    logger.info({ sessionId, source: options.sourceCtx ? `${getChannelId(options.sourceCtx)}:${getConversationId(options.sourceCtx)}` : (options.source ? `${options.source.channelId || options.source.platform}:${options.source.conversationId || options.source.channelUserId}` : 'session-event'), partCount: options.message?.parts?.length ?? options.parts?.length ?? queuedItemPartCount ?? 0 }, 'Session turn processing');

    let stoppedByUser = false;
    let fencedMaintenanceError: unknown;
    let fencedMaintenanceDirect = false;
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
          // records before consuming any additional compatible follow-ups.
          await this.appendQueuedTurnInputs(session, sessionId, queuedItems);
          queuedItems = undefined;
          parts = null;
        }

        const queuedBeforeSource = this.inspectLeadingCompatibleQueuedTurnInputs(session, turnBoundary).latestSource;
        const queuedBeforeLlm = await this.consumeLeadingQueuedTurnInputs(session, parts, turnBoundary);
        parts = queuedBeforeLlm.parts;
        if (queuedBeforeSource) {
          turnSource = queuedBeforeSource;
          turnChannelOptions = this.getTurnChannelOptions(undefined, turnSource);
        }

        if (session.stopping) {
          logger.info({ sessionId: session.id }, 'Session stopping flag detected, halting tool call loop');
          stoppedByUser = true;
          await this.host.saveSession(session);
          await this.deliverProviderResultText(
            session, options.sourceCtx, turnSource, '_[Execution stopped by user]_', false, broadcast, turnChannelOptions,
          );
          break;
        }

        // This is the safe boundary immediately before a provider call: queued
        // inputs and the preceding tool result have already been persisted, so
        // an interval reminder cannot split a function call from its result.
        await this.maybeAppendGoalIntervalReminder(session);

        this.emitTurnProgress(broadcast, turnChannelOptions, { type: 'llm-start' });
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
            onRetry: this.createLlmRetryNotifier(session, broadcast, () => turnChannelOptions),
            turnId,
          });
        } catch (e: any) {
          if (session.stopping && llm.isAbortError(e)) {
            logger.info({ sessionId: session.id }, 'In-flight LLM request aborted by stop signal');
            stoppedByUser = true;
            await this.host.saveSession(session);
            await this.deliverProviderResultText(
              session, options.sourceCtx, turnSource, '_[Execution stopped by user]_', false, broadcast, turnChannelOptions,
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
        // point so compatible follow-ups received during the provider request
        // participate in the same canonical runner semantics as local queues.
        await this.host.ingestPendingQueue?.(session);
        // Dequeue may arrive while the awaited Worker ingestion is publishing
        // its newly hot queue. Do not fold those rows into the current provider
        // result after the stop override has claimed them for the outer loop.
        const stopOverrideAfterProviderIngest = !!session.meta?.runQueuedAfterStop;
        const providerTimeQueue = stopOverrideAfterProviderIngest
          ? { hasInput: false, latestSource: undefined }
          : this.inspectLeadingCompatibleQueuedTurnInputs(session, turnBoundary);
        if (providerTimeQueue.latestSource) {
          turnSource = providerTimeQueue.latestSource;
          turnChannelOptions = this.getTurnChannelOptions(undefined, turnSource);
        }
        // Decide this result's finality from a non-mutating queue view. Queue
        // rows append only after this text and, for tools, after the tool row.
        const hasTools = !!result.toolCalls?.length;
        const willContinue = hasTools || providerTimeQueue.hasInput;
        if (!willContinue && isNoActionSignalText(result.text) && resolveChildHandoffBoundary(session)) {
          await this.host.saveSession(session);
        }
        const iterationTextHandled = await this.deliverProviderResultText(
          session,
          options.sourceCtx,
          turnSource,
          result.text,
          willContinue,
          broadcast,
          turnChannelOptions,
        );

        if (!hasTools) {
          if (providerTimeQueue.hasInput) {
            const queuedAfterLlm = await this.consumeLeadingQueuedTurnInputs(session, null, turnBoundary);
            if (!queuedAfterLlm.consumedInput) {
              await this.finishTurnAfterIntermediate(session, turnSource, broadcast, turnChannelOptions);
              break;
            }
            await this.maybeRequestAutoCompactionBeforeContinuation(session, result.usage, iteration);
            iteration++;
            continue;
          }
          break;
        }

        const turnToolCalls = this.getTurnToolCalls(result.toolCalls!, iteration);

        const hasBroadcastableToolText = shouldBroadcastChannelText(result.text);

        this.emitTurnProgress(broadcast, turnChannelOptions, {
          type: 'tool-calls-start',
          calls: turnToolCalls.map(call => ({ id: call.id, name: call.name })),
          ...(hasBroadcastableToolText ? { text: result.text } : {}),
        });

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
          broadcast: this.buildToolBroadcast(broadcast, turnChannelOptions),
          ...(turnChannelOptions.qqbotMessageId && turnChannelOptions.qqbotChannelId && turnChannelOptions.qqbotConversationId
            ? { channelReplyMetadata: {
              qqbotMessageId: turnChannelOptions.qqbotMessageId,
              qqbotChannelId: turnChannelOptions.qqbotChannelId,
              qqbotConversationId: turnChannelOptions.qqbotConversationId,
            } }
            : {}),
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
        this.emitTurnProgress(broadcast, turnChannelOptions, {
          type: 'tool-calls-finish',
          results: this.getToolResultProgress(toolResultMsg),
        });

        const waitForReply = (toolResultMsg as any).__toolPostAction?.waitForReply === true;
        if (waitForReply && !session.stopping && !session.meta?.wait) {
          await this.host.startSessionWait(session);
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
          await this.finishTurnAfterIntermediate(session, turnSource, broadcast, turnChannelOptions);
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
            await this.finishTurnAfterIntermediate(session, turnSource, broadcast, turnChannelOptions);
          } else {
            await this.deliverProviderResultText(
              session, options.sourceCtx, turnSource, '_[Execution stopped by user]_', false, broadcast, turnChannelOptions,
            );
          }
          break;
        }

        if ((toolResultMsg as any).__toolLoopControl?.stopCurrentTurn) {
          logger.info({ sessionId: session.id, iteration }, 'Tool requested immediate turn stop');
          await this.finishTurnAfterIntermediate(session, turnSource, broadcast, turnChannelOptions);
          break;
        }

        if (waitForReply) {
          logger.info({ sessionId: session.id, iteration }, 'Successful handoff requested an activity wait');
          await this.finishTurnAfterIntermediate(session, turnSource, broadcast, turnChannelOptions);
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
            await this.finishTurnAfterIntermediate(session, turnSource, broadcast, turnChannelOptions);
          } else {
            await this.deliverProviderResultText(
              session, options.sourceCtx, turnSource, '_[Execution stopped by user]_', false, broadcast, turnChannelOptions,
            );
          }
          break;
        }
        const toolTimeSource = this.inspectLeadingCompatibleQueuedTurnInputs(session, turnBoundary).latestSource;
        if (toolTimeSource) {
          turnSource = toolTimeSource;
          turnChannelOptions = this.getTurnChannelOptions(undefined, turnSource);
        }
        const queuedAfterTools = await this.consumeLeadingQueuedTurnInputs(session, null, turnBoundary);
        parts = queuedAfterTools.parts;

        await this.maybeRequestAutoCompactionBeforeContinuation(session, result.usage, iteration);

        iteration++;
      }

      if (iteration >= 500) {
        await this.deliverProviderResultText(
          session,
          options.sourceCtx,
          turnSource,
          'Error: Too many tool call iterations',
          false,
          broadcast,
          turnChannelOptions,
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
        if (this.host.deliverCommittedFinal && turnSource) {
          await this.host.deliverCommittedFinal(session, turnSource, errorText, 'error');
        } else {
          await this.sendSessionError(session, options.sourceCtx, e, turnChannelOptions, turnSource);
        }
        return 'suppress-trailing-handoff';
      }
      if (mutationFencedMaintenance) {
        fencedMaintenanceError = e;
        if (this.host.deliverCommittedFinal && turnSource) {
          fencedMaintenanceDirect = true;
          await this.host.deliverCommittedFinal(session, turnSource, errorText, 'error');
          return;
        }
      } else if (!llm.isLlmRequestError(e)) {
        await this.appendTerminalModelMessage(session, errorText);
      }
      if (!mutationFencedMaintenance && this.host.deliverCommittedFinal && turnSource) {
        await this.maybeQueueChildReminder(session);
        await this.host.deliverCommittedFinal(session, turnSource, errorText, 'error');
        return;
      }
      if (mutationFencedMaintenance) {
        // Source-less fenced maintenance must surface after the exact release
        // attempt without entering any generic history/reminder/send branch.
      } else if (llm.isLlmRequestError(e)) {
        await this.maybeQueueChildReminder(session);
        if (this.host.hasBroadcast(session)) {
          this.sendEmptyTurnFinal(broadcast, turnChannelOptions);
        } else {
          await this.sendSessionError(session, options.sourceCtx, e, turnChannelOptions, turnSource);
        }
      } else {
        await this.maybeQueueChildReminder(session);
        await this.sendSessionError(session, options.sourceCtx, e, turnChannelOptions, turnSource);
      }
    } finally {
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

  async processSessionRetry(sessionId: string, source?: QueueSource): Promise<void> {
    await this.processSessionQueue(sessionId, { retry: true, retrySource: source });
  }

  async processSessionQueue(sessionId: string, options: { retry?: boolean; retrySource?: QueueSource } = {}): Promise<void> {
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
            source: options.retrySource,
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
        // The selected compact or source turn then commits its own mutation.
        await this.host.saveSession(session);

        if (session.queue[0]?.type === 'compact-commit') {
          session.queue.shift();
          await this.runQueuedCompaction(sessionId, session);
          continue;
        }

        const queuedTurn = this.drainLeadingQueuedTurnInputs(session);
        if (queuedTurn.items.length === 0) {
          break;
        }
        const outcome = await this.runSessionTurn(sessionId, {
          parts: null,
          queuedItems: queuedTurn.items,
          session,
          source: queuedTurn.broadcastSource,
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
