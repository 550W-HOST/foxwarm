import WebSocket, { RawData } from 'ws';
import { Channel, ChannelContext, ChannelMessage } from '../channel';
import { logger } from '../common';
import type { QQBotConfig } from '../config';

const QQBOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQBOT_API_BASE_URL = 'https://api.sgroup.qq.com';
const QQBOT_INTENTS = 1_073_741_824 + 4_096 + 33_554_432 + 67_108_864;
const RECONNECT_DELAY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_C2C_TYPING_CONTEXTS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_RECENT_INBOUND_EVENTS = 10_000;
const MAX_REPLY_SEQUENCES = 10_000;
const RATE_LIMIT_RECONNECT_DELAY_MS = 60_000;
const PASSIVE_REPLY_TTL_MS = 60 * 60 * 1_000;
const MAX_PASSIVE_TEXT_REPLIES = 4;
const MAX_PASSIVE_REPLY_CONTEXTS = 10_000;
const MAX_PASSIVE_REPLY_CHAINS = 10_000;
const MAX_MESSAGE_SCENE_EXT_ITEMS = 32;
const MAX_MESSAGE_SCENE_EXT_ITEM_LENGTH = 256;

type QQBotConversationKind = 'c2c' | 'group' | 'guild' | 'dm';

type QQBotConversation = {
  kind: QQBotConversationKind;
  id: string;
};

type QQBotSocket = Pick<WebSocket, 'on' | 'once' | 'send' | 'close' | 'readyState'>;

type QQBotChannelDeps = {
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => QQBotSocket;
  reconnectDelaysMs?: number[];
  invalidSessionReconnectDelayMs?: number;
};

type QQBotGatewayFrame = {
  op?: number;
  d?: any;
  s?: number;
  t?: string;
};

type QQBotSendOptions = {
  replyToId?: string;
  qqbotMessageId?: string;
  qqbotChannelId?: string;
  qqbotConversationId?: string;
  qqbotSourceBound?: boolean;
  turnFinal?: boolean;
};

type PassiveReplyContext = {
  firstSeenAt: number;
  successfulTextReplies: number;
};

type PassiveReplyChain = {
  generation: number;
  barrier: Promise<void>;
};

function toText(data: RawData | string): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new Error(`QQ Bot ${label} is required`);
  }
  return text;
}

function normalizeBusinessScalar(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= 128 && !/[\u0000-\u001F\u007F]/.test(normalized)
    ? normalized
    : undefined;
}

function getMessageSceneIndex(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    if (value.length > MAX_MESSAGE_SCENE_EXT_ITEMS) {
      return undefined;
    }
    let result: string | undefined;
    for (const item of value) {
      if (typeof item !== 'string' || item.length > MAX_MESSAGE_SCENE_EXT_ITEM_LENGTH) {
        return undefined;
      }
      if (!item.startsWith('msg_idx=')) {
        continue;
      }
      const normalized = normalizeBusinessScalar(item.slice('msg_idx='.length));
      if (!normalized || result) {
        return undefined;
      }
      result = normalized;
    }
    return result;
  }
  if (value && typeof value === 'object') {
    return normalizeBusinessScalar((value as any).msg_idx);
  }
  return undefined;
}

export function parseQQBotConversationId(value: string): QQBotConversation {
  const separator = value.indexOf(':');
  const kind = separator === -1 ? '' : value.slice(0, separator);
  const id = separator === -1 ? '' : value.slice(separator + 1).trim();
  if (!id || !['c2c', 'group', 'guild', 'dm'].includes(kind)) {
    throw new Error('QQ Bot conversationId must be c2c:<openid>, group:<group-openid>, guild:<channel-id>, or dm:<guild-id>');
  }
  return { kind: kind as QQBotConversationKind, id };
}

export function isQQBotChannelConfigReady(config: QQBotConfig | Record<string, any>): boolean {
  return Boolean(config.appId?.trim() && config.clientSecret?.trim());
}

/**
 * Official QQ Bot gateway adapter. It deliberately supports text-only
 * C2C/group/guild/direct-message events; QQ media is not guessed or fetched.
 */
export class QQBotChannel implements Channel {
  readonly name: string;
  readonly platform = 'qqbot';
  private readonly channelId: string;
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: (url: string) => QQBotSocket;
  private readonly reconnectDelaysMs: number[];
  private readonly invalidSessionReconnectDelayMs: number;

  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private socket?: QQBotSocket;
  private stopped = true;
  private connectionGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private sessionId?: string;
  private lastSequence: number | null = null;
  private lastHeartbeatAckAt?: number;
  private heartbeatAwaitingAck = false;
  private accessToken?: { value: string; expiresAt: number };
  private accessTokenRequest?: Promise<string>;
  private latestC2CMessageIds = new Map<string, string>();
  private recentInboundEvents = new Map<string, true>();
  private replySequences = new Map<string, number>();
  private passiveReplyContexts = new Map<string, PassiveReplyContext>();
  private passiveReplyChains = new Map<string, PassiveReplyChain>();

  constructor(config: QQBotConfig, name = 'qqbot', deps: QQBotChannelDeps = {}) {
    this.name = name;
    this.channelId = name;
    this.appId = config.appId?.trim() || '';
    this.clientSecret = config.clientSecret?.trim() || '';
    this.fetchFn = deps.fetch || globalThis.fetch;
    this.createWebSocket = deps.createWebSocket || ((url) => new WebSocket(url));
    this.reconnectDelaysMs = deps.reconnectDelaysMs || RECONNECT_DELAY_MS;
    this.invalidSessionReconnectDelayMs = deps.invalidSessionReconnectDelayMs ?? 3_000;
  }

  async start(): Promise<void> {
    requireText(this.appId, 'appId');
    requireText(this.clientSecret, 'clientSecret');
    if (!this.fetchFn) {
      throw new Error('QQ Bot requires a fetch-capable Node.js runtime');
    }
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.reconnectAttempt = 0;
    const generation = ++this.connectionGeneration;
    await this.connect(generation);
    logger.info({ channelId: this.channelId }, 'QQ Bot channel started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connectionGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    this.latestC2CMessageIds.clear();
    this.recentInboundEvents.clear();
    this.replySequences.clear();
    this.passiveReplyContexts.clear();
    this.passiveReplyChains.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      socket.close();
    }
    logger.info({ channelId: this.channelId }, 'QQ Bot channel stopped');
  }

  async sendMessage(conversationId: string, text: string, options?: QQBotSendOptions): Promise<void> {
    const target = parseQQBotConversationId(conversationId);
    const content = String(text || '');
    if (!content.trim()) {
      return;
    }

    const directReplyId = typeof options?.replyToId === 'string' && options.replyToId.trim()
      ? options.replyToId.trim()
      : undefined;
    const boundReplyId = options?.qqbotChannelId === this.channelId
      && options?.qqbotConversationId === conversationId
      && typeof options.qqbotMessageId === 'string'
      && options.qqbotMessageId.trim()
      ? options.qqbotMessageId.trim()
      : undefined;
    const replyToId = directReplyId || boundReplyId;
    const sourceBoundPassiveReply = Boolean(replyToId && (options?.qqbotSourceBound || boundReplyId));
    const replyGeneration = this.connectionGeneration;
    const messagePath = target.kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(target.id)}/messages`
      : target.kind === 'group'
        ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
        : target.kind === 'guild'
          ? `/channels/${encodeURIComponent(target.id)}/messages`
          : `/dms/${encodeURIComponent(target.id)}/messages`;

    const send = async (): Promise<void> => {
      const useProactiveFallback = sourceBoundPassiveReply && this.shouldUseProactiveReply(replyToId!);
      const passiveReplyId = useProactiveFallback ? undefined : replyToId;
      const messageSequence = passiveReplyId && (target.kind === 'c2c' || target.kind === 'group')
        ? this.allocateReplySequence(passiveReplyId)
        : undefined;
      const body = target.kind === 'c2c' || target.kind === 'group'
        ? {
            content,
            msg_type: 0,
            ...(passiveReplyId ? { msg_id: passiveReplyId, msg_seq: messageSequence } : {}),
          }
        : {
            content,
            ...(passiveReplyId ? { msg_id: passiveReplyId } : {}),
          };

      try {
        await this.apiRequest(messagePath, 'POST', body);
      } catch (error) {
        if (sourceBoundPassiveReply && options?.turnFinal) {
          logger.error({ err: error, channelId: this.channelId, conversationId, fallbackAttempted: useProactiveFallback }, 'QQ Bot source-bound final reply could not be delivered');
          return;
        }
        throw error;
      }
      if (sourceBoundPassiveReply && passiveReplyId && this.isCurrentReplyGeneration(replyGeneration)) {
        this.recordPassiveTextReply(passiveReplyId);
      }
      if (replyToId && options?.turnFinal && this.isCurrentReplyGeneration(replyGeneration)) {
        this.replySequences.delete(replyToId);
      }
    };

    if (!sourceBoundPassiveReply) {
      await send();
      return;
    }
    try {
      await this.enqueuePassiveReply(replyToId!, replyGeneration, send);
    } catch (error) {
      if (options?.turnFinal) {
        logger.error({ err: error, channelId: this.channelId, conversationId }, 'QQ Bot source-bound final reply could not enter delivery queue');
        return;
      }
      throw error;
    }
  }

  async sendTyping(conversationId: string): Promise<void> {
    const target = parseQQBotConversationId(conversationId);
    if (target.kind !== 'c2c') {
      return;
    }
    const messageId = this.latestC2CMessageIds.get(conversationId);
    if (!messageId) {
      return;
    }
    await this.sendC2CTyping(conversationId, messageId);
  }

  private async sendC2CTyping(conversationId: string, messageId: string): Promise<void> {
    const target = parseQQBotConversationId(conversationId);
    if (target.kind !== 'c2c') {
      return;
    }
    await this.apiRequest(`/v2/users/${encodeURIComponent(target.id)}/messages`, 'POST', {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 10 },
      msg_id: messageId,
      msg_seq: this.allocateReplySequence(messageId),
    });
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private async connect(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    const gateway = await this.apiRequest<{ url?: string }>('/gateway', 'GET');
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    const gatewayUrl = requireText(gateway?.url, 'gateway URL');
    const socket = this.createWebSocket(gatewayUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };
      socket.once('open', () => {
        if (!this.isCurrentSocket(socket, generation)) {
          return;
        }
        opened = true;
        this.reconnectAttempt = 0;
        settle(resolve);
      });
      socket.once('error', (error: Error) => settle(() => reject(error)));
      socket.once('close', (code: number) => settle(() => reject(new Error(`QQ Bot gateway closed before opening (code ${code})`))));
      socket.on('message', (data: RawData) => {
        void this.handleGatewayMessage(socket, generation, data);
      });
      socket.on('error', (error: Error) => {
        if (this.isCurrentSocket(socket, generation)) {
          logger.warn({ err: error, channelId: this.channelId }, 'QQ Bot gateway error');
        }
      });
      socket.on('close', (code: number, reason: Buffer) => {
        if (!this.isCurrentSocket(socket, generation)) {
          return;
        }
        this.socket = undefined;
        this.stopHeartbeat();
        if (opened && !this.stopped) {
          this.handleGatewayClose(code, reason.toString());
        }
      });
    });
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.stopped && this.connectionGeneration === generation;
  }

  private isCurrentSocket(socket: QQBotSocket, generation: number): boolean {
    return this.isCurrentGeneration(generation) && this.socket === socket;
  }

  private clearGatewaySession(): void {
    this.sessionId = undefined;
    this.lastSequence = null;
  }

  private requestReconnect(socket: QQBotSocket, generation: number, delay?: number, clearSession = false, clearToken = false): void {
    if (!this.isCurrentSocket(socket, generation)) {
      return;
    }
    if (clearSession) {
      this.clearGatewaySession();
    }
    if (clearToken) {
      this.accessToken = undefined;
    }
    this.stopHeartbeat();
    this.socket = undefined;
    const nextGeneration = ++this.connectionGeneration;
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    this.scheduleReconnect(nextGeneration, delay);
  }

  private scheduleReconnect(generation: number, delay?: number): void {
    if (!this.isCurrentGeneration(generation) || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      logger.error({ channelId: this.channelId }, 'QQ Bot gateway reconnect limit reached');
      return;
    }
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const waitMs = delay ?? (this.reconnectDelaysMs[index] || 1_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      void this.connect(generation).catch((error) => {
        logger.warn({ err: error, channelId: this.channelId }, 'QQ Bot gateway reconnect failed');
        this.scheduleReconnect(generation);
      });
    }, waitMs);
  }

  private handleGatewayClose(code: number, reason: string): void {
    const socket = this.socket;
    if (socket) {
      return;
    }
    const generation = this.connectionGeneration;
    if (code === 1000 || this.stopped) {
      return;
    }
    if (code === 4914 || code === 4915) {
      logger.error({ channelId: this.channelId, code, reason }, 'QQ Bot gateway rejected configured intents; not reconnecting');
      return;
    }
    let delay: number | undefined;
    let clearSession = false;
    let clearToken = false;
    if (code === 4004) {
      clearToken = true;
    } else if (code === 4008) {
      delay = RATE_LIMIT_RECONNECT_DELAY_MS;
    } else if (code === 4006 || code === 4007 || code === 4009 || (code >= 4900 && code <= 4913)) {
      clearSession = true;
      clearToken = true;
    }
    if (clearSession) {
      this.clearGatewaySession();
    }
    if (clearToken) {
      this.accessToken = undefined;
    }
    logger.warn({ channelId: this.channelId, code, reason }, 'QQ Bot gateway closed; scheduling reconnect');
    this.scheduleReconnect(generation, delay);
  }

  private async handleGatewayMessage(socket: QQBotSocket, generation: number, data: RawData): Promise<void> {
    if (!this.isCurrentSocket(socket, generation)) {
      return;
    }
    let frame: QQBotGatewayFrame;
    try {
      frame = JSON.parse(toText(data));
    } catch (error) {
      logger.warn({ err: error, channelId: this.channelId }, 'Ignoring malformed QQ Bot gateway frame');
      return;
    }

    if (typeof frame.s === 'number') {
      this.lastSequence = frame.s;
    }

    if (frame.op === 10) {
      const token = await this.getAccessToken();
      if (!this.isCurrentSocket(socket, generation)) {
        return;
      }
      socket.send(JSON.stringify({
        op: this.sessionId && this.lastSequence !== null ? 6 : 2,
        d: {
          token: `QQBot ${token}`,
          ...(this.sessionId && this.lastSequence !== null
            ? { session_id: this.sessionId, seq: this.lastSequence }
            : { intents: QQBOT_INTENTS, shard: [0, 1] }),
        },
      }));
      this.startHeartbeat(socket, generation, Number(frame.d?.heartbeat_interval));
      return;
    }

    if (frame.op === 11) {
      this.heartbeatAwaitingAck = false;
      this.lastHeartbeatAckAt = Date.now();
      return;
    }

    if (frame.op === 7) {
      this.requestReconnect(socket, generation);
      return;
    }

    if (frame.op === 9) {
      const canResume = frame.d === true;
      this.requestReconnect(socket, generation, this.invalidSessionReconnectDelayMs, !canResume, !canResume);
      return;
    }

    if (frame.op !== 0 || !frame.t) {
      return;
    }

    if (frame.t === 'READY') {
      const sessionId = typeof frame.d?.session_id === 'string' ? frame.d.session_id.trim() : '';
      if (sessionId) {
        this.sessionId = sessionId;
      }
      return;
    }
    if (frame.t === 'RESUMED') {
      return;
    }

    if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'].includes(frame.t)) {
      return;
    }
    await this.routeInboundMessage(frame.t, frame.d, frame.s);
  }

  private startHeartbeat(socket: QQBotSocket, generation: number, intervalMs: number): void {
    this.stopHeartbeat();
    if (!this.isCurrentSocket(socket, generation) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.heartbeatAwaitingAck = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.isCurrentSocket(socket, generation) && socket.readyState === WebSocket.OPEN) {
        if (this.heartbeatAwaitingAck) {
          logger.warn({ channelId: this.channelId, lastHeartbeatAckAt: this.lastHeartbeatAckAt }, 'QQ Bot gateway missed heartbeat ACK; reconnecting');
          this.requestReconnect(socket, generation);
          return;
        }
        this.heartbeatAwaitingAck = true;
        socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    this.heartbeatAwaitingAck = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async routeInboundMessage(eventType: string, event: any, sequence?: number): Promise<void> {
    const content = typeof event?.content === 'string' ? event.content : '';
    if (!content.trim()) {
      logger.info({ channelId: this.channelId, eventType, messageId: event?.id }, 'Ignoring QQ Bot non-text message');
      return;
    }

    const inbound = this.normalizeInboundEvent(eventType, event);
    if (!inbound) {
      logger.warn({ channelId: this.channelId, eventType, messageId: event?.id }, 'Ignoring QQ Bot event without a stable identity');
      return;
    }

    if (this.isDuplicateInboundEvent(eventType, inbound.messageId, event)) {
      logger.info({ channelId: this.channelId, eventType, messageId: inbound.messageId, sequence }, 'Ignoring duplicate QQ Bot inbound event');
      return;
    }
    this.rememberPassiveReplyContext(inbound.messageId);

    if (inbound.kind === 'c2c') {
      if (!this.latestC2CMessageIds.has(inbound.conversationId) && this.latestC2CMessageIds.size >= MAX_C2C_TYPING_CONTEXTS) {
        const oldestConversationId = this.latestC2CMessageIds.keys().next().value;
        if (oldestConversationId) {
          this.latestC2CMessageIds.delete(oldestConversationId);
        }
      }
      this.latestC2CMessageIds.set(inbound.conversationId, inbound.messageId);
    }

    const context: ChannelContext = {
      channelId: this.channelId,
      channelType: this.platform,
      channelUserId: inbound.conversationId,
      conversationId: inbound.conversationId,
      username: inbound.username,
      senderId: inbound.senderId,
      qqbotMessageId: inbound.messageId,
      platform: this.platform,
      // QQ accepts a bounded passive reply window for the inbound msg_id.
      // This callback is only used while this native context is live.
      preferDirectReply: true,
      reply: async (text: string, options?: QQBotSendOptions) => {
        await this.sendMessage(inbound.conversationId, text, { ...options, replyToId: inbound.messageId, qqbotSourceBound: true });
      },
      sendTyping: async () => {
        await this.sendC2CTyping(inbound.conversationId, inbound.messageId);
      },
    };
    const message: ChannelMessage = {
      parts: [{ text: content }],
      channelUserId: inbound.conversationId,
      conversationId: inbound.conversationId,
      username: inbound.username,
    };

    try {
      await this.messageHandler?.(context, message);
    } catch (error) {
      logger.error({ err: error, channelId: this.channelId, eventType, messageId: inbound.messageId }, 'QQ Bot inbound handler failed');
    }
  }

  private normalizeInboundEvent(eventType: string, event: any): { kind: QQBotConversationKind; conversationId: string; senderId: string; username: string; messageId: string } | null {
    const messageId = typeof event?.id === 'string' ? event.id.trim() : '';
    if (!messageId) {
      return null;
    }
    if (eventType === 'C2C_MESSAGE_CREATE') {
      const senderId = typeof event?.author?.user_openid === 'string' ? event.author.user_openid.trim() : '';
      return senderId ? { kind: 'c2c', conversationId: `c2c:${senderId}`, senderId, username: senderId, messageId } : null;
    }
    if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      const senderId = typeof event?.author?.member_openid === 'string' ? event.author.member_openid.trim() : '';
      const groupId = typeof event?.group_openid === 'string' ? event.group_openid.trim() : '';
      return senderId && groupId
        ? { kind: 'group', conversationId: `group:${groupId}`, senderId, username: String(event?.author?.username || senderId), messageId }
        : null;
    }
    if (eventType === 'AT_MESSAGE_CREATE') {
      const senderId = typeof event?.author?.id === 'string' ? event.author.id.trim() : '';
      const channelId = typeof event?.channel_id === 'string' ? event.channel_id.trim() : '';
      return senderId && channelId
        ? { kind: 'guild', conversationId: `guild:${channelId}`, senderId, username: String(event?.author?.username || senderId), messageId }
        : null;
    }
    const senderId = typeof event?.author?.id === 'string' ? event.author.id.trim() : '';
    const guildId = typeof event?.guild_id === 'string' ? event.guild_id.trim() : '';
    return senderId && guildId
      ? { kind: 'dm', conversationId: `dm:${guildId}`, senderId, username: String(event?.author?.username || senderId), messageId }
      : null;
  }

  private isDuplicateInboundEvent(eventType: string, messageId: string, event: any): boolean {
    const messageSequence = normalizeBusinessScalar(event?.msg_seq);
    const messageIndex = getMessageSceneIndex(event?.message_scene?.ext);
    const key = `${eventType}:${messageId}:${messageSequence ? `seq=${messageSequence}` : 'seq=-'}:${messageIndex ? `idx=${messageIndex}` : 'idx=-'}`;
    if (this.recentInboundEvents.has(key)) {
      return true;
    }
    if (this.recentInboundEvents.size >= MAX_RECENT_INBOUND_EVENTS) {
      const oldest = this.recentInboundEvents.keys().next().value;
      if (oldest) {
        this.recentInboundEvents.delete(oldest);
      }
    }
    this.recentInboundEvents.set(key, true);
    return false;
  }

  private allocateReplySequence(messageId: string): number {
    const previous = this.replySequences.get(messageId) || 0;
    if (!this.replySequences.has(messageId) && this.replySequences.size >= MAX_REPLY_SEQUENCES) {
      const oldest = this.replySequences.keys().next().value;
      if (oldest) {
        this.replySequences.delete(oldest);
      }
    }
    const next = previous + 1;
    this.replySequences.set(messageId, next);
    return next;
  }

  private rememberPassiveReplyContext(messageId: string): PassiveReplyContext {
    const existing = this.passiveReplyContexts.get(messageId);
    if (existing) {
      return existing;
    }
    const now = Date.now();
    for (const [id, context] of this.passiveReplyContexts) {
      if (now - context.firstSeenAt >= PASSIVE_REPLY_TTL_MS * 2) {
        this.passiveReplyContexts.delete(id);
      }
    }
    if (this.passiveReplyContexts.size >= MAX_PASSIVE_REPLY_CONTEXTS) {
      const oldest = this.passiveReplyContexts.keys().next().value;
      if (oldest) {
        this.passiveReplyContexts.delete(oldest);
      }
    }
    const context = { firstSeenAt: now, successfulTextReplies: 0 };
    this.passiveReplyContexts.set(messageId, context);
    return context;
  }

  private shouldUseProactiveReply(messageId: string): boolean {
    const context = this.rememberPassiveReplyContext(messageId);
    return Date.now() - context.firstSeenAt >= PASSIVE_REPLY_TTL_MS
      || context.successfulTextReplies >= MAX_PASSIVE_TEXT_REPLIES;
  }

  private recordPassiveTextReply(messageId: string): void {
    const context = this.rememberPassiveReplyContext(messageId);
    context.successfulTextReplies += 1;
  }

  private isCurrentReplyGeneration(generation: number): boolean {
    return !this.stopped && this.connectionGeneration === generation;
  }

  private enqueuePassiveReply(messageId: string, generation: number, operation: () => Promise<void>): Promise<void> {
    const existing = this.passiveReplyChains.get(messageId);
    const previous = existing?.generation === generation ? existing.barrier : undefined;
    if (!previous && this.passiveReplyChains.size >= MAX_PASSIVE_REPLY_CHAINS) {
      return Promise.reject(new Error('QQ Bot has too many concurrent source-bound reply chains'));
    }
    const result: Promise<void> = (previous || Promise.resolve<void>(undefined))
      .catch((): void => undefined)
      .then(async (): Promise<void> => {
        if (!this.isCurrentReplyGeneration(generation)) {
          throw new Error('QQ Bot source-bound reply was invalidated before delivery');
        }
        await operation();
      });
    const barrier: Promise<void> = result.then((): void => undefined, (): void => undefined);
    const chain: PassiveReplyChain = { generation, barrier };
    this.passiveReplyChains.set(messageId, chain);
    void barrier.finally(() => {
      if (this.passiveReplyChains.get(messageId) === chain) {
        this.passiveReplyChains.delete(messageId);
      }
    });
    return result;
  }

  private async apiRequest<T = any>(path: string, method: 'GET' | 'POST', body?: Record<string, any>): Promise<T> {
    return this.requestWithToken<T>(path, method, body, false);
  }

  private async requestWithToken<T>(path: string, method: 'GET' | 'POST', body: Record<string, any> | undefined, retried: boolean): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchFn(`${QQBOT_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && !retried) {
      this.accessToken = undefined;
      return this.requestWithToken(path, method, body, true);
    }
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`QQ Bot API ${method} ${path} failed (${response.status}): ${responseText.slice(0, 300)}`);
    }
    if (!responseText.trim()) {
      return {} as T;
    }
    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new Error(`QQ Bot API ${method} ${path} returned invalid JSON`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - Date.now() > 60_000) {
      return this.accessToken.value;
    }
    if (this.accessTokenRequest) {
      return this.accessTokenRequest;
    }
    this.accessTokenRequest = (async () => {
      const response = await this.fetchFn(QQBOT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`QQ Bot access token request failed (${response.status}): ${responseText.slice(0, 300)}`);
      }
      let payload: any;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error('QQ Bot access token response was not JSON');
      }
      const token = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
      if (!token) {
        throw new Error('QQ Bot access token response did not include access_token');
      }
      const expiresIn = Number(payload?.expires_in);
      this.accessToken = {
        value: token,
        expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1_000 : 7_200_000),
      };
      return token;
    })();
    try {
      return await this.accessTokenRequest;
    } finally {
      this.accessTokenRequest = undefined;
    }
  }

}
