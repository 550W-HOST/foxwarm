/** Canonical per-session queue and turn state machine. */

import { logger } from './common';
import { ChannelContext, getChannelId, getChannelType, getConversationId } from './channel';
import { buildChildReminder, isModelNoActionSignal } from './session/childSessionReminder';
import { getManagedSessionState, setManagedSessionState } from './session/managedState';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
import { maybeRefreshStaleSessionSnapshot } from './session/snapshotRefresh';
import { maybeBuildGoalReminderMessage } from './session/goal';
import type { SessionTurnFinalKind } from './sessionTurnDelivery';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import { ChannelTurnProgress, ChannelTurnToolResult, FunctionCall, isQueueItem, Message, MessagePart, QueueItem, QueueSource, Session } from './types';
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
  deliverCommittedFinal?(session: Session, source: QueueSource, text: string, outcome: SessionTurnFinalKind): Promise<void>;
}

export type LocalSessionTurnHostOverrides = Partial<Pick<SessionTurnHost,
  'applyCompletedCompactJob' | 'processSessionCompactionRequest' | 'checkAndCompactIfNeeded'
  | 'queueSessionSystemEvent' | 'refreshSessionSnapshot' | 'deliverCommittedFinal'>>;

/** Existing in-process effects, exposed without changing their behavior. */
export class LocalSessionTurnHost implements SessionTurnHost {
  private readonly currentSessionEffects: llm.CurrentSessionTurnEffects;
  readonly deliverCommittedFinal?: SessionTurnHost['deliverCommittedFinal'];

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
    return {
      platform: getChannelType(ctx),
      channelId: getChannelId(ctx),
      channelType: getChannelType(ctx),
      channelUserId: getConversationId(ctx),
      conversationId: getConversationId(ctx),
      username: ctx.username,
      senderId: ctx.senderId,
      weworkStreamId: ctx.weworkStreamId,
      qqbotMessageId: ctx.qqbotMessageId,
      ...(ctx.preferDirectReply === true ? { preferDirectReply: true } : {}),
    };
  }

  private getSourceStreamKey(source?: QueueSource): string | undefined {
    if (source?.weworkStreamId) return `${source.channelId || source.platform}:${source.conversationId || source.channelUserId}:${source.weworkStreamId}`;
    if (source?.qqbotMessageId) return `qqbot:${source.channelId || source.platform}:${source.conversationId || source.channelUserId}:${source.qqbotMessageId}`;
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

  private createLlmRetryNotifier(session: Session, broadcast: Session['broadcast'] | undefined): (event: llm.LlmRetryEvent) => Promise<void> {
    let retryMessage: Message | null = null;

    return async (event: llm.LlmRetryEvent) => {
      const chunk = formatRetryStatus(event, retryMessage === null);
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

      if (broadcast) {
        broadcast(formatRetryChannelSnippet(event), mergeExcludePlatforms({ parse_mode: 'Markdown' }, ['webui']));
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
      // A different WeWork stream or final-delivery intent owns a separate
      // turn. Leave it queued so its progress/final routing remains coherent.
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
        await this.host.appendSessionMessage(session, item.message);
        continue;
      }

      if (!item.parts?.length) {
        continue;
      }

      consumedInput = true;
      await this.appendUserMessage(session, item.parts, item.clientMessageId);
    }

    return {
      parts,
      consumedInput,
    };
  }

  private async appendQueuedTurnInputs(session: Session, sessionId: string, items: QueueItem[]): Promise<void> {
    let firstInputItem = true;
    for (const item of items) {
      if (item.message) {
        await this.host.appendSessionMessage(session, item.message);
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
      await this.appendUserMessage(session, parts, item.clientMessageId);
      firstInputItem = false;
    }
  }

  private async finalizeStoppedSession(session: Session): Promise<number> {
    let committedMessages = 0;
    let committedAnyInput = false;

    while (true) {
      const messages: Message[] = [];
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
      if (messages.length > 0) {
        await this.host.appendSessionMessages(session, messages);
        committedMessages += messages.length;
      } else {
        await this.host.saveSession(session);
      }
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

  private async continueWithQueuedWork(session: Session): Promise<false | 'processed' | 'suppress-trailing-handoff'> {
    while (session.queue[0] && !isQueueItem(session.queue[0])) {
      session.queue.shift();
    }
    if (session.queue.length === 0) {
      return false;
    }

    await this.host.saveSession(session);

    if (session.queue[0]?.type === 'compact-commit') {
      const nextItem = session.queue.shift();
      if (!nextItem) {
        return false;
      }

      await this.processQueuedItem(session.id, session, nextItem);
      return 'processed';
    }

    const queuedTurn = this.drainLeadingQueuedTurnInputs(session);
    if (queuedTurn.items.length === 0) {
      return false;
    }

    const outcome = await this.runSessionTurn(session.id, {
      parts: null,
      queuedItems: queuedTurn.items,
      session,
      preclaimed: true,
      source: queuedTurn.broadcastSource,
    });
    return outcome === 'suppress-trailing-handoff' ? outcome : 'processed';
  }

  private async runPendingCompactionIfNeeded(sessionId: string, session: Session): Promise<'continued' | false> {
    while (session.queue[0] && !isQueueItem(session.queue[0])) {
      session.queue.shift();
    }
    const nextItem = session.queue[0];
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
    } finally {
      if (await this.continueWithQueuedWork(session)) {
        return;
      }

      await this.host.updateSessionBusyState(session, false);
    }
  }

  private async processQueuedItem(sessionId: string, session: Session, item: QueueItem): Promise<void> {
    if (item.type === 'compact-commit') {
      await this.runQueuedCompaction(sessionId, session);
      return;
    }

    await this.runSessionTurn(sessionId, {
      parts: null,
      queuedItems: [item],
      source: item.type === 'user' ? item.source : undefined,
      session,
      preclaimed: true,
    });
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

  private async sendFinalResponse(session: Session, sourceCtx: ChannelContext | undefined, source: QueueSource | undefined, response: string, alreadyBroadcasted: boolean, turnOptions?: Record<string, any>): Promise<boolean> {
    if (!alreadyBroadcasted && shouldBroadcastChannelText(response)) {
      await this.sendSessionReply(session, sourceCtx, response, this.mergeTurnOptions(turnOptions || {}, { excludePlatforms: ['webui'], turnFinal: true }), source);
      return true;
    }
    return false;
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
      preclaimed?: boolean;
    }
  ): Promise<'suppress-trailing-handoff' | void> {
    const session = options.session ?? await this.host.getSession(sessionId);
    if (options.parts?.length || options.message || options.queuedItems?.length) {
      sessionManager.clearSessionWaitForDirectTurn(session, options.message || options.queuedItems?.some(item => item.message) ? 'direct-message-turn' : 'direct-parts-turn');
    }
    if (!options.preclaimed) {
      await this.host.updateSessionBusyState(session, true);
    }

    await maybeRefreshStaleSessionSnapshot(session, this.host.refreshSessionSnapshot);

    const turnSource = options.source ?? (options.sourceCtx ? this.snapshotSource(options.sourceCtx) : undefined);
    const turnChannelOptions = this.getTurnChannelOptions(undefined, turnSource);
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
      let finalResponse = '';
      let finalUsage = null;
      let lastTextBroadcasted = false;
      while (iteration < 500) {
        const pendingCompaction = await this.runPendingCompactionIfNeeded(sessionId, session);
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

        const queuedBeforeLlm = await this.consumeLeadingQueuedTurnInputs(session, parts, turnBoundary);
        parts = queuedBeforeLlm.parts;

        if (session.stopping) {
          logger.info({ sessionId: session.id }, 'Session stopping flag detected, halting tool call loop');
          stoppedByUser = true;
          await this.host.saveSession(session);

          finalResponse = finalResponse
            ? finalResponse + '\n\n_[Execution stopped by user]_'
            : '_[Execution stopped by user]_';
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
            onRetry: this.createLlmRetryNotifier(session, broadcast),
          });
        } catch (e: any) {
          if (session.stopping && llm.isAbortError(e)) {
            logger.info({ sessionId: session.id }, 'In-flight LLM request aborted by stop signal');
            stoppedByUser = true;
            await this.host.saveSession(session);

            finalResponse = finalResponse
              ? finalResponse + '\n\n_[Execution stopped by user]_'
              : '_[Execution stopped by user]_';
            break;
          }
          throw e;
        }

        // llm.chat appends non-null parts to canonical history before returning.
        // Keep only unsent inputs across a pre-LLM compact boundary; otherwise a
        // compact commit between tool iterations would replay this turn's user
        // input in the next provider request.
        parts = null;
        finalResponse = result.text;
        finalUsage = result.usage;

        if (result.usage) {
          session.stats.lastUsage = result.usage;
        }

        if (!result.toolCalls?.length) {
          lastTextBroadcasted = false;
          break;
        }

        const turnToolCalls = this.getTurnToolCalls(result.toolCalls, iteration);

        const hasBroadcastableToolText = shouldBroadcastChannelText(result.text);
        if (hasBroadcastableToolText && broadcast) {
          const excludePlatforms = Array.from(new Set([
            'webui',
            ...(turnChannelOptions.weworkStreamChannelId ? [turnChannelOptions.weworkStreamChannelId] : []),
          ]));
          broadcast(result.text, { parse_mode: 'Markdown', excludePlatforms });
          lastTextBroadcasted = true;
        }

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
          break;
        }

        if (session.stopping) {
          logger.info({ sessionId: session.id, iteration }, 'Session stopping flag detected after tool execution, halting tool call loop');
          stoppedByUser = true;
          await this.host.saveSession(session);

          finalResponse = finalResponse
            ? finalResponse + '\n\n_[Execution stopped by user]_'
            : '_[Execution stopped by user]_';
          break;
        }

        if ((toolResultMsg as any).__toolLoopControl?.stopCurrentTurn) {
          logger.info({ sessionId: session.id, iteration }, 'Tool requested immediate turn stop');
          break;
        }

        if (waitForReply) {
          logger.info({ sessionId: session.id, iteration }, 'Successful handoff requested a generic reply wait');
          break;
        }

        const compactionAfterTools = await this.runPendingCompactionIfNeeded(sessionId, session);
        if (compactionAfterTools === 'continued') {
          iteration++;
          continue;
        }

        const queuedAfterTools = await this.consumeLeadingQueuedTurnInputs(session, null, turnBoundary);
        parts = queuedAfterTools.parts;

        if (result.usage) {
          const currentSize = sessionManager.getUsageTotalTokens(result.usage);
          const compactThreshold = sessionManager.getEffectiveCompactThresholdTokens(session);
          if (currentSize > compactThreshold) {
            logger.info({ currentSize, compactThreshold, sessionThresholdOverride: session.compactThresholdTokens, iteration }, 'Context size exceeded threshold during tool calls, triggering compact');
            await this.host.processSessionCompactionRequest(session.id, {
              completionMarker: 'Compaction completed. You can continue working now.',
            }, 'auto');
            logger.info('Compact requested, continuing with current history');
          }
        }

        iteration++;
      }

      if (iteration >= 500) {
        finalResponse = 'Error: Too many tool call iterations';
      }

      const response = finalResponse;
      const usage = finalUsage;

      if (usage) {
        session.stats.lastUsage = usage;
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

      await this.maybeQueueChildReminder(session);
      const workerFinal = this.host.deliverCommittedFinal && turnSource
        ? (shouldBroadcastChannelText(response) ? 'response' : (turnSource.weworkStreamId ? 'empty-final' : undefined))
        : undefined;
      if (workerFinal) await this.host.deliverCommittedFinal!(session, turnSource!, workerFinal === 'empty-final' ? '' : response, workerFinal);
      const finalSent = workerFinal ? true : await this.sendFinalResponse(session, options.sourceCtx, turnSource, response, lastTextBroadcasted, turnChannelOptions);
      if (!finalSent) {
        this.sendEmptyTurnFinal(broadcast, turnChannelOptions);
      }
      if (!stoppedByUser) {
        await this.host.checkAndCompactIfNeeded(sessionId, usage);
      }
    } catch (e: any) {
      logger.error(e, 'Error handling message');
      const errorText = formatTerminalSessionError(e);
      const mutationFencedMaintenance = e?.code === 'SESSION_WORKER_AUTO_COMPACTION_FATAL';
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
        try { await this.host.updateSessionBusyState(session, false); }
        catch (releaseError) { if (fencedMaintenanceDirect) throw releaseError; throw fencedMaintenanceError; }
        if (!fencedMaintenanceDirect) throw fencedMaintenanceError;
        return 'suppress-trailing-handoff';
      }
      const runQueuedAfterStop = !!session.meta?.runQueuedAfterStop;
      if (session.meta?.runQueuedAfterStop) {
        delete session.meta.runQueuedAfterStop;
      }
      const stopCompleted = stoppedByUser || !!session.stopping;

      if (stopCompleted && !runQueuedAfterStop) {
        await this.finalizeStoppedSession(session);
        return;
      }
      if (session.stopping) {
        session.stopping = false;
      }

      if ((!stopCompleted || runQueuedAfterStop) && !getManagedSessionState(session)?.currentStep) {
        const continued = await this.continueWithQueuedWork(session);
        if (continued) return continued === 'suppress-trailing-handoff' ? continued : undefined;
      }

      await this.host.updateSessionBusyState(session, false);
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
    let claimed = false;
    let failed = false;
    let suppressTrailingHandoff = false;
    try {
      const session = await this.host.getExistingSession(sessionId);
      if (!session) {
        return;
      }
      if (!await this.tryClaimSession(session)) {
        if (options.retry) {
          throw new Error('Session is already busy');
        }
        return;
      }
      claimed = true;

      if (options.retry) {
        const outcome = await this.runSessionTurn(sessionId, {
          parts: null,
          session,
          preclaimed: true,
        });
        suppressTrailingHandoff = outcome === 'suppress-trailing-handoff';
        return;
      }

      const continued = await this.continueWithQueuedWork(session);
      suppressTrailingHandoff = continued === 'suppress-trailing-handoff';
      if (continued) {
        return;
      }

      await this.host.updateSessionBusyState(session, false);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.processingSessions.delete(sessionId);
      // An item can become visible after the previous loop's final queue scan
      // but before this processor releases ownership. If it arrived after the
      // stop boundary it is new work, so hand it to a fresh processor rather
      // than losing the enqueue trigger to this re-entrancy guard.
      const session = await this.host.getExistingSession(sessionId);
      if (claimed
        && !failed
        && !suppressTrailingHandoff
        && session
        && !session.busy
        && !this.host.isSessionDestructiveLifecycleClaimed(session.id)
        && session.queue.some(isQueueItem)) {
        void this.processSessionQueue(sessionId).catch(error => {
          logger.error({ err: error, sessionId }, 'Trailing queued work failed');
        });
      }
    }
  }
}
