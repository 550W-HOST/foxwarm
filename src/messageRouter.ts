/** Message ingress: authorization, commands, channel/session resolution, and QueueItem construction. */

import fs from 'fs-extra';
import { logger } from './common';
import { ChannelContext, ChannelMessage, getChannelId, getChannelType, getConversationId } from './channel';
import { formatAuthorizationInspection, inspectChannelAuthorizationFromContext } from './channelAuth';
import { getAgentDir, getChannelConfigById, readAppConfigFile } from './config';
import { isManagedSessionActive } from './session/managedState';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import type { SessionWorkerIngressResult } from './sessionWorkerIngress';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import { MessagePart, QueueItem, QueueSource, Session } from './types';
import { formatLocalTimestamp } from './utils/localTime';
import { formatFoxwarmMessage, formatFoxwarmMessageClose, formatFoxwarmMessageOpen, formatFoxwarmSystemTag } from './utils/promptWrappers';

export { shouldBroadcastChannelText } from './sessionTurnRunner';

export type SessionWorkerSubmitHandler = (
  sessionId: string,
  item: QueueItem,
  context: ChannelContext,
) => Promise<SessionWorkerIngressResult>;

function formatCurrentTimeForPrompt(date: Date): string {
  return formatLocalTimestamp(date);
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
    if (!hasOnlyText) return undefined;
    chunks.push(part.text || '');
  }
  return chunks.join('\n');
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

export class MessageRouter {
  private authorizedUsers: Map<string, boolean> = new Map();
  private commandHandler?: (ctx: ChannelContext, command: string, args: string[], rawArgs?: string) => Promise<boolean>;
  private readonly turnRunner = new SessionTurnRunner(new LocalSessionTurnHost());

  constructor(
    authorizedUsers?: Array<{ platform: string; userId: string }>,
    private readonly workerSubmit?: SessionWorkerSubmitHandler,
  ) {
    if (authorizedUsers) {
      for (const user of authorizedUsers) {
        this.authorizedUsers.set(`${user.platform}:${user.userId}`, true);
      }
    }
  }


  /**
   * Add source/runtime system parts for incoming user messages.
   */
  private addSourceSystemParts(
    parts: MessagePart[],
    source: QueueSource,
    ingressMetadataParts: MessagePart[] = [],
  ): void {
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
    if (textOnlyContent !== undefined && ingressMetadataParts.length === 0) {
      parts.splice(0, parts.length, ...systemParts, { system: formatFoxwarmMessage(sourceAttrs, textOnlyContent) });
      return;
    }

    parts.unshift(
      ...systemParts,
      { system: formatFoxwarmMessageOpen(sourceAttrs) },
      ...ingressMetadataParts.map(part => ({ ...part })),
    );
    parts.push({ system: formatFoxwarmMessageClose() });
  }


  private prepareUserParts(
    parts: MessagePart[],
    source?: QueueSource,
    ingressMetadataParts: MessagePart[] = [],
  ): MessagePart[] {
    const preparedParts = [...parts];
    if (source) {
      this.addSourceSystemParts(preparedParts, source, ingressMetadataParts);
    }
    return preparedParts;
  }

  private buildChannelUserQueueItem(ctx: ChannelContext, message: ChannelMessage): QueueItem {
    const source = this.turnRunner.snapshotSource(ctx);
    return {
      type: 'user',
      source,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      parts: this.prepareUserParts(message.parts, source, message.ingressMetadataParts),
    };
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
      hydrateExisting: this.workerSubmit ? false : undefined,
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
    return sessionManager.getOrCreateSessionForChannel(getChannelId(ctx), getConversationId(ctx), {
      hydrateExisting: this.workerSubmit ? false : undefined,
    });
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
    const authorizedAtIngress = this.isAuthorized(getChannelId(ctx), getChannelType(ctx), getConversationId(ctx), ctx.senderId);

    if (!authorizedAtIngress) {
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

    let routedMessage = message;
    if (authorizedAtIngress && message.materializeParts) {
      try {
        routedMessage = { ...message, parts: await message.materializeParts(sessionId) };
      } catch (error) {
        logger.error({ err: error, channelId: getChannelId(ctx), conversationId: getConversationId(ctx) }, 'Authorized channel media materialization failed');
      }
    }

    if (getChannelType(ctx) !== 'internal') {
      session.meta.lastChannel = {
        channelId: getChannelId(ctx),
        channelType: getChannelType(ctx),
        channelUserId: getConversationId(ctx),
        conversationId: getConversationId(ctx),
      };
    }

    const queueItem = this.buildChannelUserQueueItem(ctx, routedMessage);

    if (isManagedSessionActive(session)) {
      await sessionRuntime.enqueue(sessionId, queueItem);
      await this.turnRunner.sendSessionReply(session, ctx, '🧭 Session is under managed control; your message was queued for its manager.');
      return;
    }

    if (this.workerSubmit) {
      // Session-worker placement: the durable mailbox owns busy/idle queuing.
      // A failure here never falls back to the local runner; a post-append
      // ambiguous outcome remains durable retryable work.
      await this.workerSubmit(sessionId, queueItem, ctx);
      return;
    }

    if (session.busy) {
      logger.info({ channelId: getChannelId(ctx), channelType: getChannelType(ctx), user: ctx.username }, 'Session busy, queueing message');
      await sessionRuntime.enqueue(sessionId, queueItem);
      // Intentionally no user-facing busy/queued notice: the message remains
      // queued and will be processed when the current turn finishes.
      return;
    }

    await sessionRuntime.enqueue(sessionId, queueItem);
    await this.processSessionQueue(sessionId);
  }

  /**
   * Process queue for a session by ID (works for both child sessions and channel sessions)
   */

  async processSessionRetry(sessionId: string): Promise<void> {
    await this.turnRunner.processSessionRetry(sessionId);
  }

  async processSessionQueue(sessionId: string, options: { retry?: boolean } = {}): Promise<void> {
    await this.turnRunner.processSessionQueue(sessionId, options);
  }
}
