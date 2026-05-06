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
import { maybeRefreshStaleSessionSnapshot } from './session/snapshotRefresh';
import { maybeBuildTodoEndTurnReminderMessage } from './session/todo';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import { Message, MessagePart, QueueItem, QueueSource, Session, SessionReply } from './types';
import { formatMessageText, formatPrefixedMultilineText } from './utils/messageFormat';
import { formatLocalTimestamp } from './utils/localTime';

const SUBCONSCIOUS_RETRY_BUSY_MS = 1500;

type SubconsciousRetryTimer = {
  timeout: NodeJS.Timeout;
  dueAt: number;
};

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

export class MessageRouter {
  private authorizedUsers: Map<string, boolean> = new Map();
  private processingSessions: Set<string> = new Set();
  private commandHandler?: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>;
  private subconsciousRetryTimers: Map<string, SubconsciousRetryTimer> = new Map();

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
    const senderInfo = source.username ? `; sender: \`${source.username}\`` : '';
    systemParts.push({ system: `The following message is a direct user message via channel; channel_instance_id: \`${channelInstanceId}\`; channel_type: \`${channelType}\`; conversation_id: \`${conversationId}\`; channel_target_id: \`${channelTargetId}\`${senderInfo}` });

    // Send-only channel notice
    if (conversationId) {
      const channelConfig = sessionManager.getChannelConfig(channelInstanceId, conversationId);
      logger.debug({ channelInstanceId, channelType, conversationId, channelConfig }, 'Channel config check for send-only');
      if (channelConfig?.mode === 'send-only') {
        systemParts.push({ system: `Channel is in send-only mode. If you need to reply, call send_to_channel({channelTargetId: "${channelTargetId}", message: "..."}).` });
        logger.info({ channelInstanceId, conversationId }, 'Send-only system part added');
      }
    }

    parts.unshift(...systemParts);
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
    };
  }

  private getSessionReply(session: Session, sourceCtx?: ChannelContext): SessionReply | undefined {
    if (sourceCtx?.preferDirectReply && sourceCtx.reply) {
      return sourceCtx.reply.bind(sourceCtx);
    }
    return session.broadcast ?? sourceCtx?.reply?.bind(sourceCtx);
  }

  private async sendSessionReply(session: Session, sourceCtx: ChannelContext | undefined, text: string, options?: any): Promise<void> {
    const reply = this.getSessionReply(session, sourceCtx);
    if (!reply) return;
    await reply(text, options);
  }

  private prepareUserParts(parts: MessagePart[], source?: QueueSource): MessagePart[] {
    const preparedParts = [...parts];
    if (source) {
      this.addSourceSystemParts(preparedParts, source);
    }
    return preparedParts;
  }

  private prepareTurnParts(session: Session, sessionId: string, parts: MessagePart[], source?: QueueSource): MessagePart[] {
    const finalParts = this.prepareUserParts(parts, source);

    const now = Date.now();
    const timeSinceLastMessage = now - (session.meta.lastMessageTime || now);
    if (timeSinceLastMessage > 10 * 60 * 1000) {
      const currentTime = formatCurrentTimeForPrompt(new Date());
      finalParts.unshift({ system: `current time = ${currentTime}` });
    }
    session.meta.lastMessageTime = now;

    if (session.history.length === 0) {
      finalParts.unshift({ system: `current session ID = ${sessionId}` });
    }

    return finalParts;
  }

  private drainLeadingQueuedMessageParts(session: Session): MessagePart[] {
    const queuedParts: MessagePart[] = [];

    while (session.queue[0]
      && session.queue[0].type !== 'compact'
      && session.queue[0].type !== 'compact-commit'
      && !session.queue[0].message) {
      const item = session.queue.shift();
      if (!item?.parts) continue;

      if (item.source) {
        queuedParts.push(...this.prepareUserParts(item.parts, item.source));
        continue;
      }

      queuedParts.push(...item.parts);
    }

    return queuedParts;
  }

  private async consumeLeadingQueuedTurnInputs(
    session: Session,
    pendingParts: MessagePart[] | null,
    subconsciousIncomingParts: MessagePart[],
  ): Promise<{ parts: MessagePart[] | null; consumedInput: boolean }> {
    let mergedParts = pendingParts;
    let consumedInput = false;

    while (session.queue[0]
      && session.queue[0].type !== 'compact'
      && session.queue[0].type !== 'compact-commit') {
      const item = session.queue.shift();
      if (!item) {
        continue;
      }

      if (item.message) {
        consumedInput = true;
        if (mergedParts?.length) {
          await this.appendUserMessage(session, mergedParts);
          mergedParts = null;
        }

        await sessionManager.appendSessionMessage(session, item.message);
        continue;
      }

      if (!item.parts?.length) {
        continue;
      }

      consumedInput = true;
      const preparedParts = item.source
        ? this.prepareUserParts(item.parts, item.source)
        : [...item.parts];

      subconsciousIncomingParts.push(...preparedParts);
      mergedParts = mergedParts?.length
        ? [...mergedParts, ...preparedParts]
        : preparedParts;
    }

    return {
      parts: mergedParts,
      consumedInput,
    };
  }

  private tryClaimSession(session: Session): boolean {
    if (session.busy) {
      return false;
    }

    void sessionManager.updateSessionBusyState(session, true);
    return true;
  }

  private getQueuedTurnOptions(session: Session, item: { type: string; parts?: MessagePart[]; source?: QueueSource; message?: Message }) {
    return {
      parts: item.parts || null,
      message: item.message,
      source: item.type === 'user' ? item.source : undefined,
      session,
      preclaimed: true,
    };
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

    if (session.queue[0]?.message) {
      const nextItem = session.queue.shift();
      if (!nextItem) {
        return false;
      }

      await this.processQueuedItem(session.id, session, nextItem);
      return true;
    }

    const queuedParts = this.drainLeadingQueuedMessageParts(session);
    if (queuedParts.length === 0) {
      return false;
    }

    await this.runSessionTurn(session.id, {
      parts: queuedParts,
      session,
      preclaimed: true,
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

    await this.runSessionTurn(sessionId, this.getQueuedTurnOptions(session, item));
  }

  private async appendUserMessage(session: Session, parts: MessagePart[]): Promise<void> {
    await sessionManager.appendSessionMessage(session, {
      role: 'user',
      parts,
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
      if (msg.parts?.some(p => typeof p.system === 'string' && (p.system.startsWith('FROM:') || p.system.startsWith('The following message is a direct user message via channel;')))) {
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

  private isDirectUserMessageForSubconscious(message: any): boolean {
    return !!message?.parts?.some((part: MessagePart) => typeof part.system === 'string'
      && part.system.startsWith('The following message is a direct user message via channel;'));
  }

  private isIntersessionMessageForSubconscious(message: any): boolean {
    return !!message?.parts?.some((part: MessagePart) => typeof part.text === 'string'
      && part.text.startsWith('[SYSTEM: The following message is an inter-agent message from another session'));
  }

  private getReasoningPreviewForSubconscious(message: any): string | null {
    if (message?.role !== 'model' || !Array.isArray(message?.parts)) {
      return null;
    }

    for (const part of message.parts as MessagePart[]) {
      const summaries = Array.isArray((part as any)?.providerMeta?.thinkingSummaries)
        ? (part as any).providerMeta.thinkingSummaries.filter((entry: any) => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      const rawThinking = typeof part.thinking === 'string' && part.thinking.trim().length > 0
        ? part.thinking.trim()
        : '';
      const sourceText = summaries[0] || rawThinking;
      if (!sourceText) {
        continue;
      }

      const normalized = sourceText.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized;
    }

    return null;
  }

  private formatSubconsciousRecentContext(session: Session): string {
    const sideSessionId = sessionManager.getSubconsciousStatus(session).sideSessionId;
    const recent = session.history.slice(-12);
    const lines = recent.map((message: any) => {
      const seqLabel = typeof message?.__meta?.seq === 'number' ? `[#${message.__meta.seq}] ` : '';
      const preserveFull = this.isDirectUserMessageForSubconscious(message)
        || this.isIntersessionMessageForSubconscious(message);

      const formatted = formatMessageText(message, {
        includeRolePrefix: false,
        skipThinking: true,
        skipRagMemorySnippets: true,
        toolCharLimit: preserveFull ? 4000 : 240,
      }).trim();

      const text = preserveFull
        ? formatted
        : (formatted.length > 320 ? `${formatted.slice(0, 317)}...` : formatted);
      const reasoningPreview = this.getReasoningPreviewForSubconscious(message);
      const decoratedText = reasoningPreview && !preserveFull
        ? `${text}\n(reasoning preview: ${reasoningPreview})`
        : text;

      if (!decoratedText) {
        return `${seqLabel}[${message.role}] [empty]`;
      }

      return formatPrefixedMultilineText(`${seqLabel}[${message.role}] `, decoratedText);
    });

    if (sideSessionId) {
      return [
        `Primary session: \`${session.id}\``,
        `Bound subconscious side session: \`${sideSessionId}\``,
        '',
        'Recent primary-session context (recent real user inputs and inter-session task messages are kept in full; other messages may be truncated):',
        ...lines,
      ].join('\n');
    }

    return [
      `Primary session: \`${session.id}\``,
      '',
      'Recent primary-session context (recent real user inputs and inter-session task messages are kept in full; other messages may be truncated):',
      ...lines,
    ].join('\n');
  }

  private countSubconsciousInputMessages(session: Session, incomingParts: MessagePart[], sourceCtx?: ChannelContext, source?: QueueSource): number {
    const settings = sessionManager.getSubconsciousTriggerSettings(session);
    if (!settings.enabled || !settings.sideSessionId) {
      return 0;
    }

    let count = 0;

    if (sourceCtx || source) {
      count += 1;
    }

    for (const part of incomingParts) {
      if (typeof part.system === 'string' && part.system.startsWith('The following message is a direct user message via channel;')) {
        count += 1;
        continue;
      }

      if (typeof part.text === 'string'
        && part.text.startsWith('[SYSTEM: The following message is an inter-agent message from another session')
        && !sessionManager.shouldIgnoreSubconsciousTriggerText(part.text, settings.sideSessionId!)) {
        count += 1;
      }
    }

    return count;
  }

  private clearSubconsciousRetry(primarySessionId: string): void {
    const existing = this.subconsciousRetryTimers.get(primarySessionId);
    if (!existing) {
      return;
    }

    clearTimeout(existing.timeout);
    this.subconsciousRetryTimers.delete(primarySessionId);
  }

  private scheduleSubconsciousRetry(primarySessionId: string, delayMs: number): void {
    const normalizedDelay = Math.max(250, Math.floor(delayMs));
    const dueAt = Date.now() + normalizedDelay;
    const existing = this.subconsciousRetryTimers.get(primarySessionId);
    if (existing && existing.dueAt <= dueAt) {
      return;
    }

    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.subconsciousRetryTimers.delete(primarySessionId);
      this.processPendingSubconsciousTrigger(primarySessionId).catch(err => {
        logger.error({ err, primarySessionId }, 'Failed subconscious retry trigger');
      });
    }, normalizedDelay);

    this.subconsciousRetryTimers.set(primarySessionId, { timeout, dueAt });
  }

  private async processPendingSubconsciousTrigger(primarySessionId: string): Promise<boolean> {
    const session = await sessionManager.getExistingSession(primarySessionId);
    if (!session || sessionManager.isSubconsciousSession(session)) {
      this.clearSubconsciousRetry(primarySessionId);
      return false;
    }

    const settings = sessionManager.getSubconsciousTriggerSettings(session);
    if (!settings.enabled || !settings.sideSessionId) {
      this.clearSubconsciousRetry(primarySessionId);
      return false;
    }

    if (settings.pendingMessageCount < settings.triggerEveryMessages) {
      this.clearSubconsciousRetry(primarySessionId);
      return false;
    }

    const sideSession = await sessionManager.getExistingSession(settings.sideSessionId);
    if (!sideSession || sideSession.busy || sideSession.queue.length > 0) {
      this.scheduleSubconsciousRetry(primarySessionId, SUBCONSCIOUS_RETRY_BUSY_MS);
      return false;
    }

    await sessionManager.queueSessionStructuredEvent(settings.sideSessionId, [
      {
        system: `Subconscious trigger for primary session \`${session.id}\`. Review the recent context, optionally use your limited history/search tools, and only send a single short high-value hint back to the primary session if you find a meaningful recall, contradiction, or reminder. If there is nothing important, end with [NO_ACTION]. If you send a hint, use send_to_session({sessionId: \`${session.id}\`, message: \"[Subconscious] ...\"}) and then call end_turn({}) in the same response.`,
      },
      {
        text: this.formatSubconsciousRecentContext(session),
      },
    ], 'background');

    await sessionManager.markSubconsciousTriggered(session.id);
    this.clearSubconsciousRetry(primarySessionId);
    return true;
  }

  private async maybeRecordSubconsciousProgress(
    session: Session,
    incomingParts: MessagePart[],
    toolRoundCount: number,
    awardedMessages: number,
    sourceCtx?: ChannelContext,
    source?: QueueSource,
  ): Promise<number> {
    if (sessionManager.isSubconsciousSession(session)) {
      return awardedMessages;
    }

    const settings = sessionManager.getSubconsciousTriggerSettings(session);
    if (!settings.enabled || !settings.sideSessionId) {
      this.clearSubconsciousRetry(session.id);
      return awardedMessages;
    }

    const inputMessages = this.countSubconsciousInputMessages(session, incomingParts, sourceCtx, source);
    const totalMessages = Math.min(
      inputMessages + toolRoundCount,
      settings.triggerEveryMessages,
    );
    const delta = totalMessages - awardedMessages;
    if (delta <= 0) {
      await this.processPendingSubconsciousTrigger(session.id);
      return awardedMessages;
    }

    await sessionManager.incrementSubconsciousPending(session.id, delta);
    await this.processPendingSubconsciousTrigger(session.id);
    return totalMessages;
  }

  private async maybeQueueChildReminder(session: Session): Promise<void> {
    if (sessionManager.isSubconsciousSession(session) || !session.parentSessionId || session.history.length === 0) {
      return;
    }

    const lastMessage = session.history[session.history.length - 1];
    if (lastMessage.role !== 'model' || lastMessage.parts.some(p => p.functionCall)) {
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

  private async maybeAppendTodoEndTurnReminder(session: Session): Promise<void> {
    if (session.queue.some(item => item.type !== 'background')) {
      return;
    }

    const reminder = maybeBuildTodoEndTurnReminderMessage(session);
    if (!reminder) {
      return;
    }

    // End-turn reminders should become visible in history immediately without
    // spawning another follow-up reminder turn. Interval reminders are the ones
    // that independently re-trigger the agent loop.
    await sessionManager.appendSessionMessage(session, reminder);
  }

  private async sendFinalResponse(session: Session, sourceCtx: ChannelContext | undefined, response: string, alreadyBroadcasted: boolean): Promise<void> {
    if (!alreadyBroadcasted && shouldBroadcastChannelText(response)) {
      await this.sendSessionReply(session, sourceCtx, response, { excludePlatforms: ['webui'] });
    }
  }

  private async sendSessionError(session: Session, sourceCtx: ChannelContext | undefined, error: any): Promise<void> {
    await this.sendSessionReply(session, sourceCtx, `Error: ${error?.message || 'Unknown error'}`);
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

    const sessionId = await this.createGuestSession(channelId, conversationId, guestAgent);
    const session = await sessionManager.getSession(sessionId);
    return { sessionId, session };
  }

  private async createGuestSession(channelId: string, conversationId: string, guestAgent: NormalizedGuestAgentConfig): Promise<string> {
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
        sessionName: sessionManager.generateSessionId(),
      });
      sessionManager.attachChannel(channelId, conversationId, result.sessionId, { dangerouslyAllowAllUsers: true });
      return result.sessionId;
    }

    const newAgentName = await generateGuestAgentName(guestAgent.agentId);
    const isolatedNode = guestAgent.isolated
      ? (() => {
          if (!guestAgent.node) {
            throw new Error(`Guest inherited-mode agent "${guestAgent.agentId}" requires a node when isolated=true.`);
          }
          return guestAgent.node;
        })()
      : undefined;

    const result = await sessionManager.createAgentWithMainSession({
      agentName: newAgentName,
      createMainSession: true,
      inherit: guestAgent.agentId,
      isolatedNode,
    });
    sessionManager.attachChannel(channelId, conversationId, result.mainSessionId, { dangerouslyAllowAllUsers: true });
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

    const mentionCommandRegex = /^(?:@[a-zA-Z_\-.]+\s+)?(\/[a-zA-Z_\-.]+)(?:\s+(.*))?$/s;
    const commandMatch = messageText.match(mentionCommandRegex);
    if (!commandMatch) return false;

    const command = commandMatch[1];
    const args = commandMatch[2] ? commandMatch[2].trim().split(/\s+/) : [];

    try {
      const handled = await this.commandHandler(ctx, command, args);
      if (!handled) {
        await ctx.reply(`Unknown command: ${command}`);
      }
    } catch (e: any) {
      await ctx.reply(`Command error: ${e.message}`);
      logger.error({ err: e }, 'Command error');
    }

    return true;
  }

  private async resolveSessionForIncomingMessage(ctx: ChannelContext): Promise<{ sessionId: string; session: Session }> {
    let sessionId = sessionManager.getSessionByChannel(getChannelId(ctx), getConversationId(ctx));
    if (!sessionId) {
      sessionId = sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx));
    }

    const session = await sessionManager.getSession(sessionId);
    return { sessionId, session };
  }

  private async runSessionTurn(
    sessionId: string,
    options: {
      parts: MessagePart[] | null;
      message?: Message;
      sourceCtx?: ChannelContext;
      source?: QueueSource;
      sendTyping?: boolean;
      session?: Session;
      preclaimed?: boolean;
    }
  ): Promise<void> {
    const session = options.session ?? await sessionManager.getSession(sessionId);
    if (!options.preclaimed) {
      await sessionManager.updateSessionBusyState(session, true);
    }

    await maybeRefreshStaleSessionSnapshot(session, sessionManager.refreshSessionSnapshot);

    const broadcast = session.broadcast;
    const subconsciousIncomingParts: MessagePart[] = options.parts ? [...options.parts] : [];
    let subconsciousAwardedMessages = 0;
    let subconsciousToolRoundCount = 0;

    logger.info({ sessionId, source: options.sourceCtx ? `${getChannelId(options.sourceCtx)}:${getConversationId(options.sourceCtx)}` : (options.source ? `${options.source.channelId || options.source.platform}:${options.source.conversationId || options.source.channelUserId}` : 'session-event'), partCount: options.message?.parts?.length ?? options.parts?.length ?? 0 }, 'Session turn processing');

    try {
      if (options.sendTyping && options.sourceCtx) {
        await options.sourceCtx.sendTyping();
      }
      let managedStepYieldReason: 'tool' | null = null;
      let parts = options.message
        ? null
        : this.prepareTurnParts(
          session,
          sessionId,
          options.parts || [],
          options.source ?? (options.sourceCtx ? this.snapshotSource(options.sourceCtx) : undefined)
        );
      if (options.message) {
        await sessionManager.appendSessionMessage(session, options.message);
      }
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

        const queuedBeforeLlm = await this.consumeLeadingQueuedTurnInputs(session, parts, subconsciousIncomingParts);
        parts = queuedBeforeLlm.parts;

        if (session.stopping) {
          logger.info({ sessionId: session.id }, 'Session stopping flag detected, halting tool call loop');
          session.stopping = false;
          await sessionManager.saveSession(session.id);

          finalResponse = finalResponse
            ? finalResponse + '\n\n_[Execution stopped by user]_'
            : '_[Execution stopped by user]_';
          break;
        }

        let result;
        try {
          result = await llm.chat(parts, session, iteration);
        } catch (e: any) {
          if (session.stopping && llm.isAbortError(e)) {
            logger.info({ sessionId: session.id }, 'In-flight LLM request aborted by stop signal');
            session.stopping = false;
            await sessionManager.saveSession(session.id);

            finalResponse = finalResponse
              ? finalResponse + '\n\n_[Execution stopped by user]_' 
              : '_[Execution stopped by user]_';
            break;
          }
          throw e;
        }

        finalResponse = result.text;
        finalUsage = result.usage;

        if (result.usage) {
          session.stats.lastUsage = result.usage;
        }

        if (!result.toolCalls?.length) {
          lastTextBroadcasted = false;
          break;
        }

        if (shouldBroadcastChannelText(result.text) && broadcast) {
          await broadcast(result.text, { parse_mode: 'Markdown', excludePlatforms: ['webui'] });
          lastTextBroadcasted = true;
        }

        const toolContext = {
          sessionId: session.id,
          session,
          broadcast,
        };
        const toolResultMsg = await llm.executeTools(result.toolCalls, toolContext, session);

        await this.appendToolMessage(session, toolResultMsg.parts);

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

        subconsciousToolRoundCount += 1;
        subconsciousAwardedMessages = await this.maybeRecordSubconsciousProgress(
          session,
          subconsciousIncomingParts,
          subconsciousToolRoundCount,
          subconsciousAwardedMessages,
          options.sourceCtx,
          options.source,
        );

        if ((toolResultMsg as any).__toolLoopControl?.stopCurrentTurn) {
          logger.info({ sessionId: session.id, iteration }, 'Tool requested immediate turn stop');
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

        const queuedAfterTools = await this.consumeLeadingQueuedTurnInputs(session, null, subconsciousIncomingParts);
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
      await this.sendFinalResponse(session, options.sourceCtx, response, lastTextBroadcasted);
      await this.maybeAppendTodoEndTurnReminder(session);
      await this.maybeRecordSubconsciousProgress(
        session,
        subconsciousIncomingParts,
        subconsciousToolRoundCount,
        subconsciousAwardedMessages,
        options.sourceCtx,
        options.source,
      );
      await sessionManager.checkAndCompactIfNeeded(sessionId, usage);
    } catch (e: any) {
      logger.error(e, 'Error handling message');
      const errorText = `Error: ${e?.message || 'Unknown error'}`;
      await this.appendTerminalModelMessage(session, errorText);
      await this.maybeQueueChildReminder(session);
      await this.sendSessionError(session, options.sourceCtx, e);
      await this.maybeAppendTodoEndTurnReminder(session);
      await this.maybeRecordSubconsciousProgress(
        session,
        subconsciousIncomingParts,
        subconsciousToolRoundCount,
        subconsciousAwardedMessages,
        options.sourceCtx,
        options.source,
      );
    } finally {
      if (!getManagedSessionState(session)?.currentStep && await this.continueWithQueuedWork(session)) {
        return;
      }

      session.busy = false;
      session.busyStartedAt = undefined;
      await sessionManager.saveSession(session.id);

      if (sessionManager.isSubconsciousSession(session)) {
        const primarySessionId = sessionManager.getSubconsciousPrimarySessionId(session);
        if (primarySessionId) {
          await this.processPendingSubconsciousTrigger(primarySessionId);
        }
      }
    }
  }

  setCommandHandler(handler: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>): void {
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
        await ctx.reply(this.buildUnauthorizedMessage(ctx));
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

    if (isManagedSessionActive(session)) {
      await sessionManager.enqueueSessionItem(sessionId, {
        type: 'user',
        source: this.snapshotSource(ctx),
        parts: message.parts,
      });
      await this.sendSessionReply(session, ctx, '🧭 Session is under managed control; your message was queued for its manager.');
      return;
    }

    if (session.busy) {
      logger.info({ channelId: getChannelId(ctx), channelType: getChannelType(ctx), user: ctx.username }, 'Session busy, queueing message');
      await sessionManager.enqueueSessionItem(sessionId, {
        type: 'user',
        source: this.snapshotSource(ctx),
        parts: message.parts,
      });
      await this.sendSessionReply(session, ctx, '⏳ Request queued, currently processing another message...');
      return;
    }

    this.tryClaimSession(session);

    await this.runSessionTurn(sessionId, {
      parts: message.parts,
      sourceCtx: ctx,
      sendTyping: true,
      session,
      preclaimed: true,
    });
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

      session.busy = false;
      session.busyStartedAt = undefined;
      await sessionManager.saveSession(session.id);
    } finally {
      this.processingSessions.delete(sessionId);
    }
  }
}
