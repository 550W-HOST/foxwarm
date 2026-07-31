/**
 * Message Router - routes messages from channels to sessions
 */

import fs from 'fs-extra';
import { logger } from './common';
import { ChannelContext, ChannelMessage, getChannelId, getChannelType, getConversationId } from './channel';
import { formatAuthorizationInspection, inspectChannelAuthorizationFromContext } from './channelAuth';
import { getAgentDir, getChannelConfigById, readAppConfigFile } from './config';
import { buildChildReminder, isModelNoActionSignal } from './session/childSessionReminder';
import { getManagedSessionState, isManagedSessionActive, setManagedSessionState } from './session/managedState';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
import { maybeRefreshStaleSessionSnapshot } from './session/snapshotRefresh';
import { maybeBuildGoalReminderMessage } from './session/goal';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import { ChannelTurnProgress, ChannelTurnToolResult, FunctionCall, Message, MessagePart, QueueItem, QueueSource, Session } from './types';
import { formatLocalTimestamp } from './utils/localTime';
import { formatFoxwarmMessage, formatFoxwarmMessageClose, formatFoxwarmMessageOpen, formatFoxwarmSystemTag, parseFoxwarmOpeningTag } from './utils/promptWrappers';

function formatCurrentTimeForPrompt(date: Date): string {
  return formatLocalTimestamp(date);
}


type NormalizedGuestAgentConfig = {
  agentId: string;
  mode: 'single' | 'inherited';
  isolated: boolean;
  node?: string;
};

function normalizeGuestAgentConfig(raw: unknown): NormalizedGuestAgentConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const agentId = typeof (raw as any).agentId === 'string' ? (raw as any).agentId.trim() : '';
  if (!agentId) {
    return null;
  }

  const mode = (raw as any).mode === 'inherited' ? 'inherited' : 'single';
  const isolated = (raw as any).isolated !== false;
  const node = typeof (raw as any).node === 'string' && (raw as any).node.trim()
    ? (raw as any).node.trim()
    : undefined;

  return { agentId, mode, isolated, node };
}

async function generateGuestAgentName(baseAgentId: string): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const candidate = `${baseAgentId}_${suffix}`;
    if (await fs.pathExists(getAgentDir(candidate))) {
      continue;
    }
    return candidate;
  }

  throw new Error(`Unable to allocate a unique guest agent name for "${baseAgentId}".`);
}

export function shouldBroadcastChannelText(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

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

function getPlainTextOnlyContent(parts: MessagePart[]): string | undefined {
  const chunks: string[] = [];
  for (const part of parts) {
    const hasOnlyText = typeof part.text === 'string'
      && part.system === undefined
      && part.thinking === undefined
      && part.functionCall === undefined
      && part.functionResponse === undefined
      && part.inlineData === undefined
      && (part as any).inlineDataRef === undefined;
    if (!hasOnlyText) {
      return undefined;
    }
    chunks.push(part.text || '');
  }
  return chunks.join('\n');
}

export class MessageRouter {
  private authorizedUsers: Map<string, boolean> = new Map();
  private processingSessions: Set<string> = new Set();
  private commandHandler?: (ctx: ChannelContext, command: string, args: string[], rawArgs?: string) => Promise<boolean>;

  constructor(authorizedUsers?: Array<{ platform: string; userId: string }>) {
    if (authorizedUsers) {
      for (const user of authorizedUsers) {
        this.authorizedUsers.set(`${user.platform}:${user.userId}`, true);
      }
    }
  }

  /**
   * Add source/runtime system parts for incoming user messages.
   */
  private addSourceSystemParts(parts: MessagePart[], source: QueueSource): void {
    if (!source.platform) {
      return;
    }

    const systemParts: MessagePart[] = [];
    const channelInstanceId = source.channelId || source.platform;
    const channelType = source.channelType || source.platform;
    const conversationId = source.conversationId || source.channelUserId;
    const channelTargetId = `${channelInstanceId}:${conversationId}`;
    const inputTime = formatCurrentTimeForPrompt(new Date());
    const sourceAttrs = channelType === 'webui'
      ? {
        type: 'channel',
        channelType: 'webui',
        time: inputTime,
        hint: 'direct user message via channel',
      }
      : {
        type: 'channel',
        channelInstanceId,
        channelType,
        conversationId,
        channelTargetId,
        sender: source.username,
        time: inputTime,
        hint: 'direct user message via channel',
      };

    // Send-only channel notice
    if (conversationId) {
      const channelConfig = sessionManager.getChannelConfig(channelInstanceId, conversationId);
      logger.debug({ channelInstanceId, channelType, conversationId, channelConfig }, 'Channel config check for send-only');
      if (channelConfig?.mode === 'send-only') {
        systemParts.unshift({
          system: formatFoxwarmSystemTag({
            kind: 'channel-mode',
            time: inputTime,
            mode: 'send-only',
            channelTargetId,
            hint: `Channel is in send-only mode. If you need to reply, call send_to_channel({channelTargetId: "${channelTargetId}", message: "..."}).`,
          }),
        });
        logger.info({ channelInstanceId, conversationId }, 'Send-only system part added');
      }
    }

    const textOnlyContent = getPlainTextOnlyContent(parts);
    if (textOnlyContent !== undefined) {
      parts.splice(0, parts.length, ...systemParts, { system: formatFoxwarmMessage(sourceAttrs, textOnlyContent) });
      return;
    }

    parts.unshift(...systemParts, { system: formatFoxwarmMessageOpen(sourceAttrs) });
    parts.push({ system: formatFoxwarmMessageClose() });
  }

  private snapshotSource(ctx: ChannelContext): QueueSource {
    return {
      platform: getChannelType(ctx),
      channelId: getChannelId(ctx),
      channelType: getChannelType(ctx),
      channelUserId: getConversationId(ctx),
      conversationId: getConversationId(ctx),
      username: ctx.username,
      senderId: ctx.senderId,
      weworkStreamId: ctx.weworkStreamId,
    };
  }

  private getSourceStreamKey(source?: QueueSource): string | undefined {
    if (!source?.weworkStreamId) {
      return undefined;
    }
    return `${source.channelId || source.platform}:${source.conversationId || source.channelUserId}:${source.weworkStreamId}`;
  }

  private getTurnChannelOptions(sourceCtx?: ChannelContext, source?: QueueSource): Record<string, any> {
    const streamId = sourceCtx?.weworkStreamId || source?.weworkStreamId;
    if (!streamId) {
      return {};
    }
    const channelId = sourceCtx ? getChannelId(sourceCtx) : (source?.channelId || source?.platform);
    const conversationId = sourceCtx ? getConversationId(sourceCtx) : (source?.conversationId || source?.channelUserId);
    if (!channelId || !conversationId) {
      return { weworkStreamId: streamId };
    }
    return {
      weworkStreamId: streamId,
      weworkStreamChannelId: channelId,
      weworkStreamConversationId: conversationId,
    };
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
        await sessionManager.appendSessionMessage(session, retryMessage);
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
        await sessionManager.saveSession(session.id);
        sessionManager.notifyHistoryUpdate(session.id, retryMessage);
      }

      if (broadcast) {
        broadcast(formatRetryChannelSnippet(event), mergeExcludePlatforms({ parse_mode: 'Markdown' }, ['webui']));
      }
    };
  }

  private async sendSessionReply(session: Session, sourceCtx: ChannelContext | undefined, text: string, options?: any): Promise<void> {
    if (sourceCtx?.preferDirectReply && sourceCtx.reply) {
      await sourceCtx.reply(text, options);
      return;
    }

    if (session.broadcast) {
      session.broadcast(text, options);
      return;
    }

    if (sourceCtx?.reply) {
      await sourceCtx.reply(text, options);
    }
  }

  private prepareUserParts(parts: MessagePart[], source?: QueueSource): MessagePart[] {
    const preparedParts = [...parts];
    if (source) {
      this.addSourceSystemParts(preparedParts, source);
    }
    return preparedParts;
  }

  private buildChannelUserQueueItem(ctx: ChannelContext, message: ChannelMessage): QueueItem {
    const source = this.snapshotSource(ctx);
    return {
      type: 'user',
      source,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      parts: this.prepareUserParts(message.parts, source),
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

  private drainLeadingQueuedTurnInputs(session: Session): { items: QueueItem[]; broadcastSource?: QueueSource } {
    const items: QueueItem[] = [];
    let broadcastSource: QueueSource | undefined;
    let streamKey: string | undefined;

    while (session.queue[0]
      && session.queue[0].type !== 'compact'
      && session.queue[0].type !== 'compact-commit'
      && session.queue[0].type !== 'retry') {
      const nextStreamKey = this.getSourceStreamKey(session.queue[0].source);
      if (items.length > 0 && streamKey !== nextStreamKey) {
        break;
      }
      const item = session.queue.shift();
      if (!item) continue;
      if (!item.message && !item.parts?.length) continue;

      if (items.length === 0) {
        broadcastSource = item.source;
        streamKey = nextStreamKey;
      }

      items.push(item);
    }

    return { items, broadcastSource };
  }

  private async consumeLeadingQueuedTurnInputs(
    session: Session,
    pendingParts: MessagePart[] | null,
    turnStreamKey?: string,
  ): Promise<{ parts: MessagePart[] | null; consumedInput: boolean }> {
    let parts = pendingParts;
    let consumedInput = false;

    while (session.queue[0]
      && session.queue[0].type !== 'compact'
      && session.queue[0].type !== 'compact-commit'
      && session.queue[0].type !== 'retry') {
      const queuedStreamKey = this.getSourceStreamKey(session.queue[0].source);
      // A different WeWork stream id already has its own passive card. Leave it
      // queued so the next turn's broadcasts update/finish that card instead
      // of merging its text into the current stream card.
      if (queuedStreamKey && queuedStreamKey !== turnStreamKey) {
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
        await sessionManager.appendSessionMessage(session, item.message);
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
        await sessionManager.appendSessionMessage(session, item.message);
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
      const retainedControls: QueueItem[] = [];
      const messages: Message[] = [];
      let removedQueueItems = 0;

      for (const item of session.queue) {
        if (item.type === 'compact' || item.type === 'compact-commit') {
          retainedControls.push(item);
          continue;
        }

        removedQueueItems += 1;
        // Retry is execution intent rather than content. A genuine Stop cancels
        // it instead of leaving a hidden provider turn behind.
        if (item.type === 'retry') {
          continue;
        }
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
        sessionManager.clearActiveSessionRuntimeState(session.id);
        session.busy = false;
        session.busyStartedAt = undefined;
        await sessionManager.saveSession(session.id);
        return committedMessages;
      }

      session.queue = retainedControls;
      if (messages.length > 0) {
        await sessionManager.appendSessionMessages(session, messages);
        committedMessages += messages.length;
      } else {
        await sessionManager.saveSession(session.id);
      }
    }
  }

  private tryClaimSession(session: Session): boolean {
    if (session.busy) {
      return false;
    }

    void sessionManager.updateSessionBusyState(session, true);
    return true;
  }

  private async continueWithQueuedWork(session: Session): Promise<boolean> {
    if (session.queue.length === 0) {
      return false;
    }

    await sessionManager.saveSession(session.id);

    if (session.queue[0]?.type === 'compact' || session.queue[0]?.type === 'compact-commit') {
      const nextItem = session.queue.shift();
      if (!nextItem) {
        return false;
      }

      await this.processQueuedItem(session.id, session, nextItem);
      return true;
    }

    if (session.queue[0]?.type === 'retry') {
      const nextItem = session.queue.shift();
      if (!nextItem) {
        return false;
      }

      await this.processQueuedItem(session.id, session, nextItem);
      return true;
    }

    const queuedTurn = this.drainLeadingQueuedTurnInputs(session);
    if (queuedTurn.items.length === 0) {
      return false;
    }

    await this.runSessionTurn(session.id, {
      parts: null,
      queuedItems: queuedTurn.items,
      session,
      preclaimed: true,
      source: queuedTurn.broadcastSource,
    });
    return true;
  }

  private async runPendingCompactionIfNeeded(sessionId: string, session: Session): Promise<'continued' | 'stop' | false> {
    const nextItem = session.queue[0];
    if (nextItem?.type !== 'compact' && nextItem?.type !== 'compact-commit') {
      return false;
    }

    session.queue.shift();

    try {
      sessionManager.setActiveSessionRuntimeState(sessionId, {
        state: 'requesting-model',
        since: Date.now(),
        active: { phase: 'compaction' },
      });
      if (nextItem.type === 'compact-commit') {
        await sessionManager.applyCompletedCompactJob(sessionId);
      } else {
        await sessionManager.processSessionCompactionRequest(sessionId, {
          keepPercent: nextItem.keepPercent,
          compactGuidance: nextItem.compactGuidance,
          completionMarker: nextItem.completionMarker || 'Compaction completed. You can continue working now.',
        }, 'await');
      }
    } catch (e: any) {
      logger.error({ err: e, sessionId }, 'In-turn queued compaction failed');
      await this.sendSessionError(session, undefined, e);
    }

    return nextItem.stopAfterCurrentTurn ? 'stop' : 'continued';
  }

  private async runQueuedCompaction(sessionId: string, session: Session, item: QueueItem): Promise<void> {
    try {
      sessionManager.setActiveSessionRuntimeState(sessionId, {
        state: 'requesting-model',
        since: Date.now(),
        active: { phase: 'compaction' },
      });
      if (item.type === 'compact-commit') {
        await sessionManager.applyCompletedCompactJob(sessionId);
      } else {
        await sessionManager.processSessionCompactionRequest(sessionId, {
          keepPercent: item.keepPercent,
          compactGuidance: item.compactGuidance,
          completionMarker: item.completionMarker || 'Compaction completed.',
        });
      }
    } catch (e: any) {
      logger.error({ err: e, sessionId }, 'Queued compaction failed');
      await this.sendSessionError(session, undefined, e);
    } finally {
      if (await this.continueWithQueuedWork(session)) {
        return;
      }

      sessionManager.clearActiveSessionRuntimeState(session.id);
      session.busy = false;
      session.busyStartedAt = undefined;
      await sessionManager.saveSession(session.id);
    }
  }

  private async processQueuedItem(sessionId: string, session: Session, item: QueueItem): Promise<void> {
    if (item.type === 'compact' || item.type === 'compact-commit') {
      await this.runQueuedCompaction(sessionId, session, item);
      return;
    }

    if (item.type === 'retry') {
      await this.runSessionTurn(sessionId, {
        parts: null,
        session,
        preclaimed: true,
      });
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
    await sessionManager.appendSessionMessage(session, {
      role: 'user',
      parts,
      ...(clientMessageId ? { __meta: { clientMessageId } } : {}),
    });
  }

  private async appendToolMessage(session: Session, parts: MessagePart[]): Promise<void> {
    await sessionManager.appendSessionMessage(session, {
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
    await sessionManager.appendSessionMessage(session, {
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
      await sessionManager.queueSessionSystemEvent(session.id, reminder, 'background');
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
    await sessionManager.appendSessionMessage(session, reminder);
  }

  private async sendFinalResponse(session: Session, sourceCtx: ChannelContext | undefined, response: string, alreadyBroadcasted: boolean, turnOptions?: Record<string, any>): Promise<boolean> {
    if (!alreadyBroadcasted && shouldBroadcastChannelText(response)) {
      await this.sendSessionReply(session, sourceCtx, response, this.mergeTurnOptions(turnOptions || {}, { excludePlatforms: ['webui'], turnFinal: true }));
      return true;
    }
    return false;
  }

  private async sendSessionError(session: Session, sourceCtx: ChannelContext | undefined, error: any, turnOptions?: Record<string, any>): Promise<void> {
    const text = llm.isLlmRequestError(error)
      ? `⚠️ LLM request failed: ${error?.message || 'Unknown error'}`
      : `Error: ${error?.message || 'Unknown error'}`;
    await this.sendSessionReply(session, sourceCtx, text, this.mergeTurnOptions(turnOptions || {}, { turnFinal: true }));
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

  private async maybeCreateGuestSessionForUnauthorizedMessage(ctx: ChannelContext): Promise<{ sessionId: string; session: Session } | null> {
    const channelId = getChannelId(ctx);
    const conversationId = getConversationId(ctx);

    if (sessionManager.getSessionByChannel(channelId, conversationId)) {
      return null;
    }

    const channelEntry = getChannelConfigById(channelId, readAppConfigFile());
    const guestAgent = normalizeGuestAgentConfig((channelEntry?.config as Record<string, any> | undefined)?.guestAgent);
    if (!guestAgent) {
      return null;
    }

    const resolved = await sessionManager.getOrCreateSessionForChannel(channelId, conversationId, {
      createSession: async () => ({ session: await sessionManager.getSession(await this.createGuestSession(guestAgent)), created: true }),
      attachmentConfig: { dangerouslyAllowAllUsers: true },
    });
    return sessionManager.getChannelDangerouslyAllowAllUsers(channelId, conversationId) ? resolved : null;
  }

  private async createGuestSession(guestAgent: NormalizedGuestAgentConfig): Promise<string> {
    if (!await fs.pathExists(getAgentDir(guestAgent.agentId))) {
      throw new Error(`Guest agent source "${guestAgent.agentId}" does not exist.`);
    }

    if (guestAgent.mode === 'single') {
      if (guestAgent.isolated) {
        if (!guestAgent.node) {
          throw new Error(`Guest agent "${guestAgent.agentId}" requires a node when isolated=true.`);
        }
        if (!sessionManager.isAgentIsolated(guestAgent.agentId) || sessionManager.getAgentIsolationNode(guestAgent.agentId) !== guestAgent.node) {
          throw new Error(`Guest single-mode agent "${guestAgent.agentId}" must already be isolated on node "${guestAgent.node}".`);
        }
      } else if (sessionManager.isAgentIsolated(guestAgent.agentId)) {
        throw new Error(`Guest single-mode agent "${guestAgent.agentId}" is isolated; set guestAgent.isolated=true with the matching node or use inherited mode.`);
      }

      const result = await sessionManager.createSessionInAgent({
        agentName: guestAgent.agentId,
      });
      return result.sessionId;
    }

    const isolatedNode = guestAgent.isolated
      ? (() => {
          if (!guestAgent.node) {
            throw new Error(`Guest inherited-mode agent "${guestAgent.agentId}" requires a node when isolated=true.`);
          }
          return guestAgent.node;
        })()
      : undefined;

    let result: Awaited<ReturnType<typeof sessionManager.createAgentWithMainSession>> | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const newAgentName = await generateGuestAgentName(guestAgent.agentId);
      try {
        result = await sessionManager.createAgentWithMainSession({
          agentName: newAgentName,
          createMainSession: true,
          inherit: guestAgent.agentId,
          isolatedNode,
        });
        break;
      } catch (error: any) {
        const isAllocationCollision = error?.code === sessionManager.ARCHIVED_SESSION_ID_ERROR_CODE
          || /already exists/i.test(String(error?.message || ''));
        if (!isAllocationCollision) {
          throw error;
        }
      }
    }
    if (!result) {
      throw new Error(`Unable to allocate a unique guest agent name for "${guestAgent.agentId}".`);
    }
    return result.mainSessionId;
  }

  private async handleCommandIfNeeded(ctx: ChannelContext, messageText: string): Promise<boolean> {
    if (!this.commandHandler) return false;

    // When channel-level allow-all-users is enabled, keep command access for
    // directly authorized users only. Other users may chat normally but cannot
    // use slash commands.
    if (sessionManager.getChannelDangerouslyAllowAllUsers(getChannelId(ctx), getConversationId(ctx))
      && !this.isDirectlyAuthorized(getChannelId(ctx), getChannelType(ctx), getConversationId(ctx), ctx.senderId)) {
      return false;
    }

    const normalizedMessageText = this.stripConfiguredSelfMention(ctx, messageText);
    const mentionCommandRegex = /^(?:@[a-zA-Z_\-.]+\s+)?(\/[a-zA-Z_\-.]+)(?:\s+(.*))?$/s;
    const commandMatch = normalizedMessageText.match(mentionCommandRegex);
    if (!commandMatch) return false;

    const command = commandMatch[1];
    const rawArgs = commandMatch[2];
    const args = rawArgs ? rawArgs.trim().split(/\s+/) : [];

    try {
      const handled = await this.commandHandler(ctx, command, args, rawArgs);
      if (!handled) {
        await ctx.reply(`Unknown command: ${command}`, { turnFinal: true });
      }
    } catch (e: any) {
      await ctx.reply(`Command error: ${e.message}`, { turnFinal: true });
      logger.error({ err: e }, 'Command error');
    }

    return true;
  }

  private stripConfiguredSelfMention(ctx: ChannelContext, messageText: string): string {
    const selfName = typeof ctx.selfName === 'string' ? ctx.selfName.trim() : '';
    if (!selfName) {
      return messageText;
    }

    const mentionPrefix = `@${selfName}`;
    if (!messageText.startsWith(mentionPrefix)) {
      return messageText;
    }

    const rest = messageText.slice(mentionPrefix.length);
    if (!/^\s+/.test(rest)) {
      return messageText;
    }
    return rest.replace(/^\s+/, '');
  }

  private async resolveSessionForIncomingMessage(ctx: ChannelContext): Promise<{ sessionId: string; session: Session }> {
    return sessionManager.getOrCreateSessionForChannel(getChannelId(ctx), getConversationId(ctx));
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
  ): Promise<void> {
    const session = options.session ?? await sessionManager.getSession(sessionId);
    if (options.parts?.length || options.message || options.queuedItems?.length) {
      sessionManager.clearSessionWaitForDirectTurn(session, options.message || options.queuedItems?.some(item => item.message) ? 'direct-message-turn' : 'direct-parts-turn');
    }
    if (!options.preclaimed) {
      await sessionManager.updateSessionBusyState(session, true);
    }

    await maybeRefreshStaleSessionSnapshot(session, sessionManager.refreshSessionSnapshot);

    const turnChannelOptions = this.getTurnChannelOptions(options.sourceCtx, options.source);
    const turnStreamKey = this.getSourceStreamKey(options.source ?? (options.sourceCtx ? this.snapshotSource(options.sourceCtx) : undefined));
    const broadcast = session.broadcast
      ? (text: string, broadcastOptions?: any) => session.broadcast!(text, this.mergeTurnOptions(turnChannelOptions, broadcastOptions))
      : undefined;

    const queuedItemPartCount = options.queuedItems?.reduce(
      (count, item) => count + (item.message?.parts?.length ?? item.parts?.length ?? 0),
      0,
    );
    logger.info({ sessionId, source: options.sourceCtx ? `${getChannelId(options.sourceCtx)}:${getConversationId(options.sourceCtx)}` : (options.source ? `${options.source.channelId || options.source.platform}:${options.source.conversationId || options.source.channelUserId}` : 'session-event'), partCount: options.message?.parts?.length ?? options.parts?.length ?? queuedItemPartCount ?? 0 }, 'Session turn processing');

    let stoppedByUser = false;
    try {
      if (options.sendTyping && options.sourceCtx) {
        await options.sourceCtx.sendTyping();
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
        await sessionManager.appendSessionMessage(session, options.message);
      }
      let queuedItems = options.queuedItems;
      let iteration = 0;
      let finalResponse = '';
      let finalUsage = null;
      let lastTextBroadcasted = false;
      while (iteration < 500) {
        const pendingCompaction = await this.runPendingCompactionIfNeeded(sessionId, session);
        if (pendingCompaction === 'stop') {
          break;
        }
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

        const queuedBeforeLlm = await this.consumeLeadingQueuedTurnInputs(session, parts, turnStreamKey);
        parts = queuedBeforeLlm.parts;

        if (session.stopping) {
          logger.info({ sessionId: session.id }, 'Session stopping flag detected, halting tool call loop');
          stoppedByUser = true;
          await sessionManager.saveSession(session.id);

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
        sessionManager.setActiveSessionRuntimeState(session.id, {
          state: 'requesting-model',
          since: Date.now(),
          active: {
            iteration,
            phase: 'normal-turn',
          },
        });

        let result;
        try {
          result = await llm.chat(parts, session, iteration, {
            onRetry: this.createLlmRetryNotifier(session, broadcast),
          });
        } catch (e: any) {
          if (session.stopping && llm.isAbortError(e)) {
            logger.info({ sessionId: session.id }, 'In-flight LLM request aborted by stop signal');
            stoppedByUser = true;
            await sessionManager.saveSession(session.id);

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

        sessionManager.setActiveSessionRuntimeState(session.id, {
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
            sessionManager.setActiveSessionRuntimeState(session.id, {
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
        const toolResultMsg = await llm.executeTools(turnToolCalls, toolContext, session);

        await this.appendToolMessage(session, toolResultMsg.parts);
        this.emitTurnProgress(broadcast, turnChannelOptions, {
          type: 'tool-calls-finish',
          results: this.getToolResultProgress(toolResultMsg),
        });

        const waitForReply = (toolResultMsg as any).__toolPostAction?.waitForReply === true;
        if (waitForReply && !session.stopping && !session.meta?.wait) {
          await sessionManager.startSessionWait(session.id);
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
          await sessionManager.saveSession(session.id);

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
        if (compactionAfterTools === 'stop') {
          break;
        }
        if (compactionAfterTools === 'continued') {
          iteration++;
          continue;
        }

        const queuedAfterTools = await this.consumeLeadingQueuedTurnInputs(session, null, turnStreamKey);
        parts = queuedAfterTools.parts;

        if (result.usage) {
          const currentSize = sessionManager.getUsageTotalTokens(result.usage);
          const compactThreshold = sessionManager.getEffectiveCompactThresholdTokens(session);
          if (currentSize > compactThreshold) {
            logger.info({ currentSize, compactThreshold, sessionThresholdOverride: session.compactThresholdTokens, iteration }, 'Context size exceeded threshold during tool calls, triggering compact');
            await sessionManager.processSessionCompactionRequest(session.id, {
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
      const finalSent = await this.sendFinalResponse(session, options.sourceCtx, response, lastTextBroadcasted, turnChannelOptions);
      if (!finalSent) {
        this.sendEmptyTurnFinal(broadcast, turnChannelOptions);
      }
      if (!stoppedByUser) {
        await sessionManager.checkAndCompactIfNeeded(sessionId, usage);
      }
    } catch (e: any) {
      logger.error(e, 'Error handling message');
      const errorText = `Error: ${e?.message || 'Unknown error'}`;
      if (!llm.isLlmRequestError(e)) {
        await this.appendTerminalModelMessage(session, errorText);
      }
      if (llm.isLlmRequestError(e)) {
        await this.maybeQueueChildReminder(session);
        if (session.broadcast) {
          this.sendEmptyTurnFinal(broadcast, turnChannelOptions);
        } else {
          await this.sendSessionError(session, options.sourceCtx, e, turnChannelOptions);
        }
      } else {
        await this.maybeQueueChildReminder(session);
        await this.sendSessionError(session, options.sourceCtx, e, turnChannelOptions);
      }
    } finally {
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

      if ((!stopCompleted || runQueuedAfterStop) && !getManagedSessionState(session)?.currentStep && await this.continueWithQueuedWork(session)) {
        return;
      }

      sessionManager.clearActiveSessionRuntimeState(session.id);
      session.busy = false;
      session.busyStartedAt = undefined;
      await sessionManager.saveSession(session.id);
    }
  }

  setCommandHandler(handler: (ctx: ChannelContext, command: string, args: string[], rawArgs?: string) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  private isDirectlyAuthorized(channelId: string, channelType: string, conversationId: string, senderId?: string): boolean {
    const inspection = inspectChannelAuthorizationFromContext({
      channelId,
      channelType,
      platform: channelType,
      channelUserId: conversationId,
      conversationId,
      senderId,
      reply: async () => {},
      sendTyping: async () => {},
    }, this.authorizedUsers.keys());
    return inspection.platformAlwaysAuthorized || inspection.wildcardAuthorized || inspection.directAuthorized;
  }

  isAuthorized(channelId: string, channelType: string, conversationId: string, senderId?: string): boolean {
    if (this.isDirectlyAuthorized(channelId, channelType, conversationId, senderId)) return true;

    if (sessionManager.getChannelDangerouslyAllowAllUsers(channelId, conversationId)) {
      return true;
    }

    return false;
  }

  buildUnauthorizedMessage(ctx: ChannelContext): string {
    const inspection = inspectChannelAuthorizationFromContext(ctx, this.authorizedUsers.keys());
    return formatAuthorizationInspection(inspection, { unauthorized: true });
  }

  async handleMessage(ctx: ChannelContext, message: ChannelMessage): Promise<void> {
    let resolvedSession: { sessionId: string; session: Session } | null = null;

    if (!this.isAuthorized(getChannelId(ctx), getChannelType(ctx), getConversationId(ctx), ctx.senderId)) {
      try {
        resolvedSession = await this.maybeCreateGuestSessionForUnauthorizedMessage(ctx);
      } catch (e: any) {
        logger.error({ err: e, channelId: getChannelId(ctx), conversationId: getConversationId(ctx), senderId: ctx.senderId }, 'Failed to provision guest session for unauthorized user');
      }

      if (!resolvedSession && !this.isAuthorized(getChannelId(ctx), getChannelType(ctx), getConversationId(ctx), ctx.senderId)) {
        await ctx.reply(this.buildUnauthorizedMessage(ctx), { turnFinal: true });
        return;
      }
    }

    const messageText = message.parts.map(p => p.text || '').join('\n');
    if (await this.handleCommandIfNeeded(ctx, messageText)) {
      return;
    }

    const { sessionId, session } = resolvedSession || await this.resolveSessionForIncomingMessage(ctx);

    if (getChannelType(ctx) !== 'internal') {
      session.meta.lastChannel = {
        channelId: getChannelId(ctx),
        channelType: getChannelType(ctx),
        channelUserId: getConversationId(ctx),
        conversationId: getConversationId(ctx),
      };
    }

    const queueItem = this.buildChannelUserQueueItem(ctx, message);

    if (isManagedSessionActive(session)) {
      await sessionManager.enqueueSessionItem(sessionId, queueItem);
      await this.sendSessionReply(session, ctx, '🧭 Session is under managed control; your message was queued for its manager.');
      return;
    }

    if (session.busy) {
      logger.info({ channelId: getChannelId(ctx), channelType: getChannelType(ctx), user: ctx.username }, 'Session busy, queueing message');
      await sessionManager.enqueueSessionItem(sessionId, queueItem);
      // Intentionally no user-facing busy/queued notice: the message remains
      // queued and will be processed when the current turn finishes.
      return;
    }

    await sessionManager.enqueueSessionItem(sessionId, queueItem);
    await this.processSessionQueue(sessionId);
  }

  /**
   * Process queue for a session by ID (works for both child sessions and channel sessions)
   */
  async processSessionQueue(sessionId: string): Promise<void> {
    if (this.processingSessions.has(sessionId)) {
      return;
    }

    this.processingSessions.add(sessionId);
    try {
      const session = await sessionManager.getExistingSession(sessionId);
      if (!session) {
        return;
      }
      if (!this.tryClaimSession(session)) return;

      if (await this.continueWithQueuedWork(session)) {
        return;
      }

      sessionManager.clearActiveSessionRuntimeState(session.id);
      session.busy = false;
      session.busyStartedAt = undefined;
      await sessionManager.saveSession(session.id);
    } finally {
      this.processingSessions.delete(sessionId);
      // An item can become visible after the previous loop's final queue scan
      // but before this processor releases ownership. If it arrived after the
      // stop boundary it is new work, so hand it to a fresh processor rather
      // than losing the enqueue trigger to this re-entrancy guard.
      const session = await sessionManager.getExistingSession(sessionId);
      if (session && !session.busy && session.queue.some(item => (
        item.type !== 'compact'
        && item.type !== 'compact-commit'
        && item.type !== 'retry'
      ))) {
        void this.processSessionQueue(sessionId);
      }
    }
  }
}
