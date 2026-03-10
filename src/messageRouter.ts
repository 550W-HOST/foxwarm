/**
 * Message Router - routes messages from channels to sessions
 */

import { logger } from './common';
import { ChannelContext, ChannelMessage } from './channel';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import { MessagePart, QueueItem, QueueSource, Session, SessionReply } from './types';
import { resolveModelConfig } from './config';

function formatCurrentTimeForPrompt(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (Asia/Shanghai)`;
}

export class MessageRouter {
  private authorizedUsers: Map<string, boolean> = new Map();
  private processingSessions: Set<string> = new Set();
  private commandHandler?: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>;

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
    const userInfo = source.username ? ` (${source.username})` : '';
    systemParts.push({ system: `FROM: ${source.platform}:${source.channelUserId}${userInfo}` });

    // Push-only channel notice
    if (source.channelUserId) {
      const channelConfig = sessionManager.getChannelConfig(source.platform, source.channelUserId);
      logger.debug({ platform: source.platform, channelUserId: source.channelUserId, channelConfig }, 'Channel config check for push-only');
      if (channelConfig?.mode === 'push-only') {
        const channelId = `${source.platform}:${source.channelUserId}`;
        systemParts.push({ system: `Channel is in push-only mode. If you need to reply, call send_to_channel({channelId: "${channelId}", message: "..."}).` });
        logger.info({ channelId }, 'Push-only system part added');
      }
    }

    parts.unshift(...systemParts);
  }

  private snapshotSource(ctx: ChannelContext): QueueSource {
    return {
      platform: ctx.platform,
      channelUserId: ctx.channelUserId,
      username: ctx.username,
      senderId: ctx.senderId,
    };
  }

  private getSessionReply(session: Session, sourceCtx?: ChannelContext): SessionReply | undefined {
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

    while (session.queue[0] && session.queue[0].type !== 'compact') {
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

  private tryClaimSession(session: Session): boolean {
    if (session.busy) {
      return false;
    }

    session.busy = true;
    return true;
  }

  private getQueuedTurnOptions(session: Session, item: { type: string; parts?: MessagePart[]; source?: QueueSource }) {
    return {
      parts: item.parts || [],
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

    if (session.queue[0]?.type === 'compact') {
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

  private async runPendingCompactionIfNeeded(sessionId: string, session: Session): Promise<boolean> {
    const nextItem = session.queue[0];
    if (nextItem?.type !== 'compact') {
      return false;
    }

    session.queue.shift();

    try {
      if (nextItem.summary && nextItem.summary.trim()) {
        await sessionManager.compactHistoryWithSummary(sessionId, nextItem.summary, nextItem.keepPercent, 'Manual compaction completed. You can continue working now.');
      } else {
        await sessionManager.compactHistory(sessionId, nextItem.keepPercent, 'Compaction completed. You can continue working now.');
      }
    } catch (e: any) {
      logger.error({ err: e, sessionId }, 'In-turn queued compaction failed');
      await this.sendSessionError(session, undefined, e);
    }

    return true;
  }

  private async runQueuedCompaction(sessionId: string, session: Session, item: QueueItem): Promise<void> {
    try {
      if (item.summary && item.summary.trim()) {
        await sessionManager.compactHistoryWithSummary(sessionId, item.summary, item.keepPercent);
      } else {
        await sessionManager.compactHistory(sessionId, item.keepPercent);
      }
    } catch (e: any) {
      logger.error({ err: e, sessionId }, 'Queued compaction failed');
      await this.sendSessionError(session, undefined, e);
    } finally {
      if (await this.continueWithQueuedWork(session)) {
        return;
      }

      session.busy = false;
      await sessionManager.saveSession(session.id);
    }
  }

  private async processQueuedItem(sessionId: string, session: Session, item: QueueItem): Promise<void> {
    if (item.type === 'compact') {
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
      if (msg.parts?.some(p => p.text === 'NO_ACTION')) {
        hasNoAction = true;
      }
      if (msg.parts?.some(p => typeof p.system === 'string' && p.system.startsWith('FROM:'))) {
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

    const terminalText = lastMessage.parts.find(p => typeof p.text === 'string')?.text || '';
    if (terminalText.startsWith('Error:')) {
      return;
    }

    const { foundUser, hasSendToSession, hasNoAction, hasUserFromPrefix } = this.getChildTurnState(session);

    if (foundUser && !hasNoAction && !hasSendToSession && !hasUserFromPrefix && session.queue.length === 0) {
      const reminder = `message ended without send_to_session call. If you want to report to parent, call send_to_session({sessionId: \`${session.parentSessionId}\`, message: "..."}). If you confirmed to not sending messages, reply "NO_ACTION"`;
      await sessionManager.queueSessionSystemEvent(session.id, reminder, 'background');
    }
  }

  private async sendFinalResponse(session: Session, sourceCtx: ChannelContext | undefined, response: string, alreadyBroadcasted: boolean): Promise<void> {
    if (!alreadyBroadcasted && response) {
      await this.sendSessionReply(session, sourceCtx, response || '<empty string>', { excludePlatforms: ['webui'] });
    }
  }

  private async sendSessionError(session: Session, sourceCtx: ChannelContext | undefined, error: any): Promise<void> {
    await this.sendSessionReply(session, sourceCtx, `Error: ${error?.message || 'Unknown error'}`);
  }

  private async handleCommandIfNeeded(ctx: ChannelContext, messageText: string): Promise<boolean> {
    if (!this.commandHandler) return false;

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
    let sessionId = sessionManager.getSessionByChannel(ctx.platform, ctx.channelUserId);
    if (!sessionId) {
      sessionId = sessionManager.attachChannel(ctx.platform, ctx.channelUserId);
    }

    const session = await sessionManager.getSession(sessionId);
    return { sessionId, session };
  }

  private async runSessionTurn(
    sessionId: string,
    options: {
      parts: MessagePart[];
      sourceCtx?: ChannelContext;
      source?: QueueSource;
      sendTyping?: boolean;
      session?: Session;
      preclaimed?: boolean;
    }
  ): Promise<void> {
    const session = options.session ?? await sessionManager.getSession(sessionId);
    if (!options.preclaimed) {
      session.busy = true;
    }

    const broadcast = session.broadcast;

    logger.info({ sessionId, source: options.sourceCtx ? `${options.sourceCtx.platform}:${options.sourceCtx.channelUserId}` : (options.source ? `${options.source.platform}:${options.source.channelUserId}` : 'session-event'), partCount: options.parts.length }, 'Session turn processing');

    try {
      if (options.sendTyping && options.sourceCtx) {
        await options.sourceCtx.sendTyping();
      }
      let parts = this.prepareTurnParts(
        session,
        sessionId,
        options.parts,
        options.source ?? (options.sourceCtx ? this.snapshotSource(options.sourceCtx) : undefined)
      );
      let iteration = 0;
      let finalResponse = '';
      let finalUsage = null;
      let lastTextBroadcasted = false;
      const { contextLimit } = resolveModelConfig(session.model);

      while (iteration < 500) {
        if (await this.runPendingCompactionIfNeeded(sessionId, session)) {
          parts = null;
          continue;
        }

        const queuedParts = this.drainLeadingQueuedMessageParts(session);
        if (queuedParts.length > 0) {
          if (parts) {
            parts = [...parts, ...queuedParts];
          } else {
            await this.appendUserMessage(session, queuedParts);
          }
        }

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

        if (result.text && broadcast) {
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

        if (await this.runPendingCompactionIfNeeded(sessionId, session)) {
          parts = null;
          iteration++;
          continue;
        }

        const queuedAfterTools = this.drainLeadingQueuedMessageParts(session);
        if (queuedAfterTools.length > 0) {
          await this.appendUserMessage(session, queuedAfterTools);
        }

        if (result.usage) {
          const currentSize = sessionManager.getUsageTotalTokens(result.usage);
          if (currentSize > contextLimit * 0.8) {
            logger.info({ currentSize, contextLimit, iteration }, 'Context size exceeded threshold during tool calls, triggering compact');
            await sessionManager.compactHistory(session.id, undefined, 'Compaction completed. You can continue working now.');
            logger.info('Compact completed, continuing with updated history');
          }
        }

        parts = null;
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

      await this.maybeQueueChildReminder(session);
      await this.sendFinalResponse(session, options.sourceCtx, response, lastTextBroadcasted);
      await sessionManager.checkAndCompactIfNeeded(sessionId, usage);
    } catch (e: any) {
      logger.error(e, 'Error handling message');
      const errorText = `Error: ${e?.message || 'Unknown error'}`;
      await this.appendTerminalModelMessage(session, errorText);
      await this.maybeQueueChildReminder(session);
      await this.sendSessionError(session, options.sourceCtx, e);
    } finally {
      if (await this.continueWithQueuedWork(session)) {
        return;
      }

      session.busy = false;
      await sessionManager.saveSession(session.id);
    }
  }

  setCommandHandler(handler: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  isAuthorized(platform: string, channelUserId: string, senderId?: string): boolean {
    if (platform === 'internal') return true; // Child sessions always authorized
    if (platform === 'webui') return true; // WebUI always authorized (uses sessionId as channelUserId)
    // wecom 平台使用 senderId（用户ID）进行权限检查，而不是 channelUserId（chatId）
    const checkId = (platform === 'wework' && senderId) ? senderId : channelUserId;
    if (this.authorizedUsers.has(`${platform}:${checkId}`)) return true;
    return false;
  }

  async handleMessage(ctx: ChannelContext, message: ChannelMessage): Promise<void> {
    if (!this.isAuthorized(ctx.platform, ctx.channelUserId, ctx.senderId)) {
      await ctx.reply('Unauthorized');
      return;
    }

    const messageText = message.parts.map(p => p.text || '').join('\n');
    if (await this.handleCommandIfNeeded(ctx, messageText)) {
      return;
    }

    const { sessionId, session } = await this.resolveSessionForIncomingMessage(ctx);

    if (ctx.platform !== 'internal') {
      session.meta.lastChannel = {
        platform: ctx.platform,
        channelUserId: ctx.channelUserId,
      };
    }

    if (session.busy) {
      logger.info({ platform: ctx.platform, user: ctx.username }, 'Session busy, queueing message');
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
      await sessionManager.saveSession(session.id);
    } finally {
      this.processingSessions.delete(sessionId);
    }
  }
}
