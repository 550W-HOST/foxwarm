import WebSocket, { RawData } from 'ws';
import { Channel, ChannelContext, ChannelFile, ChannelMessage, ChannelSendFileOptions } from '../channel';
import { logger } from '../common';
import type { QQBotConfig } from '../config';
import { escapeFoxwarmTextContent, formatFoxwarmAttributes } from '../utils/promptWrappers';
import { buildQQBotAttachmentPreviewParts, materializeQQBotAttachments } from './qqbotMedia';
import { uploadQQBotFile } from './qqbotMediaUpload';

const QQBOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQBOT_API_BASE_URL = 'https://api.sgroup.qq.com';
const QQBOT_INTENTS = 1_073_741_824 + 4_096 + 33_554_432 + 67_108_864;
const RECONNECT_DELAY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_LATEST_MESSAGE_CONTEXTS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_RECENT_INBOUND_EVENTS = 10_000;
const MAX_REPLY_SEQUENCES = 10_000;
const RATE_LIMIT_RECONNECT_DELAY_MS = 60_000;
const PASSIVE_REPLY_TTL_MS = 3 * 60 * 1_000;
const MAX_PASSIVE_TEXT_REPLIES = 4;
const MAX_PASSIVE_REPLY_CONTEXTS = 10_000;
const MAX_PASSIVE_REPLY_CHAINS = 10_000;
const MAX_MESSAGE_SCENE_EXT_ITEMS = 32;
const MAX_MESSAGE_SCENE_EXT_ITEM_LENGTH = 256;
const QQBOT_MAX_TEXT_LENGTH = 2_000;
const DEFAULT_GROUP_CONTEXT_LIMIT = 10;
const MAX_GROUP_CONTEXT_LIMIT = 50;
const DEFAULT_GROUP_BATCH_WINDOW_MS = 5_000;
const MIN_GROUP_BATCH_WINDOW_MS = 250;
const MAX_GROUP_BATCH_WINDOW_MS = 30_000;
const GROUP_CONTEXT_TTL_MS = 5 * 60 * 1_000;
const MAX_GROUP_ACCUMULATORS = 1_000;
const MAX_PLATFORM_GROUP_HISTORY_SOURCE_CHARS = MAX_GROUP_CONTEXT_LIMIT * QQBOT_MAX_TEXT_LENGTH;

type QQBotConversationKind = 'c2c' | 'group' | 'guild' | 'dm';

type QQBotConversation = {
  kind: QQBotConversationKind;
  id: string;
};

type QQBotSocket = Pick<WebSocket, 'on' | 'once' | 'send' | 'close' | 'readyState'>;

type QQBotChannelDeps = {
  fetch?: typeof fetch;
  saveInboundSessionFileFromPath?: typeof import('../channelFiles').saveInboundSessionFileFromPath;
  createWebSocket?: (url: string) => QQBotSocket;
  reconnectDelaysMs?: number[];
  invalidSessionReconnectDelayMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
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
  successfulReplies: number;
  expired?: boolean;
};

type PassiveReplyChain = {
  generation: number;
  barrier: Promise<void>;
};

type NormalizedInboundEvent = {
  kind: QQBotConversationKind;
  conversationId: string;
  senderId: string;
  username: string;
  messageId: string;
};

type BufferedGroupEvent = {
  dedupKey: string;
  eventType: 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE';
  receivedAt: number;
  inbound: NormalizedInboundEvent;
  content: string;
  attachments: unknown[];
};

type GroupAccumulator = {
  context: BufferedGroupEvent[];
  current?: BufferedGroupEvent;
  openedAt?: number;
  timer?: NodeJS.Timeout;
};

type PlatformGroupHistoryItem = {
  content: string;
};

function buildQQBotGroupTriggerMetadata(eventType: string): { system: string } | undefined {
  if (eventType !== 'GROUP_AT_MESSAGE_CREATE' && eventType !== 'GROUP_MESSAGE_CREATE') return undefined;
  const mentioned = eventType === 'GROUP_AT_MESSAGE_CREATE';
  const attrs = formatFoxwarmAttributes({
    kind: 'group-message',
    mentioned: mentioned ? 'true' : 'false',
    hint: mentioned
      ? 'The current group message explicitly mentioned this agent.'
      : 'The current group message is ordinary group chat and did not mention this agent.',
  });
  return { system: `<foxwarm-metadata ${attrs} />` };
}

function normalizePlatformHistoryComparable(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function parsePlatformGroupHistoryBody(body: string): string[] | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const records: string[] = [];
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  while (index < lines.length) {
    if (!/^===\s*消息\s+\d+\s*===$/.test(lines[index].trim())) return null;
    index += 1;
    if (index >= lines.length) return null;
    const contentMatch = /^\[消息内容\][ \t]*(.*)$/.exec(lines[index]);
    if (!contentMatch) return null;
    const contentLines = [contentMatch[1]];
    index += 1;
    while (index < lines.length && !/^===\s*消息\s+\d+\s*===$/.test(lines[index].trim())) {
      contentLines.push(lines[index]);
      index += 1;
    }
    while (contentLines.length > 1 && !contentLines[contentLines.length - 1].trim()) contentLines.pop();
    const content = contentLines.join('\n').trim();
    if (content) records.push(content);
  }
  return records.length > 0 ? records : null;
}

function extractPlatformGroupHistory(
  value: unknown,
  currentContent: string,
  limit: number,
): PlatformGroupHistoryItem[] {
  if (limit <= 0 || !Array.isArray(value)) return [];
  const records: Array<{ content: string; parsed: boolean }> = [];
  let remainingChars = MAX_PLATFORM_GROUP_HISTORY_SOURCE_CHARS;
  for (const element of value.slice(0, MAX_GROUP_CONTEXT_LIMIT)) {
    if (records.length >= MAX_GROUP_CONTEXT_LIMIT || remainingChars <= 0) break;
    if (typeof element?.content !== 'string') continue;
    const boundedBody = element.content.slice(0, remainingChars);
    remainingChars -= boundedBody.length;
    if (!boundedBody.trim()) continue;
    const parsed = parsePlatformGroupHistoryBody(boundedBody);
    if (parsed) {
      for (const record of parsed) {
        if (records.length >= MAX_GROUP_CONTEXT_LIMIT) break;
        records.push({ content: record, parsed: true });
      }
    }
    else records.push({ content: boundedBody.trim(), parsed: false });
  }
  if (records.length > 0 && records[records.length - 1].parsed
    && normalizePlatformHistoryComparable(records[records.length - 1].content)
      === normalizePlatformHistoryComparable(currentContent)) {
    records.pop();
  }
  return records.slice(-limit).map(record => ({ content: record.content }));
}

function normalizeGroupContextLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_GROUP_CONTEXT_LIMIT;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_GROUP_CONTEXT_LIMIT) {
    throw new Error(`QQ Bot groupContextLimit must be an integer between 0 and ${MAX_GROUP_CONTEXT_LIMIT}`);
  }
  return Number(value);
}

function normalizeGroupBatchWindowMs(value: unknown): number {
  if (value === undefined) return DEFAULT_GROUP_BATCH_WINDOW_MS;
  if (!Number.isInteger(value)
    || (Number(value) !== 0 && (Number(value) < MIN_GROUP_BATCH_WINDOW_MS || Number(value) > MAX_GROUP_BATCH_WINDOW_MS))) {
    throw new Error(`QQ Bot groupBatchWindowMs must be 0 or an integer between ${MIN_GROUP_BATCH_WINDOW_MS} and ${MAX_GROUP_BATCH_WINDOW_MS}`);
  }
  return Number(value);
}

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

function normalizeQQBotCaption(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const caption = value.trim().slice(0, QQBOT_MAX_TEXT_LENGTH);
  return caption || undefined;
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('QQ Bot API response exceeded the bounded media-upload response limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('QQ Bot API response exceeded the bounded media-upload response limit');
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    reader.releaseLock();
  }
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

class QQBotApiError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'QQBotApiError';
    this.code = code;
  }
}

function parseQQBotApiErrorCode(responseText: string): number | undefined {
  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return undefined;
  }
  for (const candidate of [payload?.code, payload?.err_code]) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && /^-?\d+$/u.test(candidate.trim())) {
      const code = Number(candidate.trim());
      if (Number.isSafeInteger(code)) return code;
    }
  }
  return undefined;
}

function isQQBotMessageExpiredError(error: unknown): boolean {
  return error instanceof QQBotApiError && error.code === 40034005;
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

/** Official QQ Bot gateway adapter for text and bounded C2C/group inbound media. */
export class QQBotChannel implements Channel {
  readonly name: string;
  readonly platform = 'qqbot';
  private readonly channelId: string;
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly requireMention: boolean;
  private readonly groupContextLimit: number;
  private readonly groupBatchWindowMs: number;
  private readonly mediaConfig: QQBotConfig['media'];
  private readonly saveInboundSessionFileFromPath?: QQBotChannelDeps['saveInboundSessionFileFromPath'];
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: (url: string) => QQBotSocket;
  private readonly reconnectDelaysMs: number[];
  private readonly invalidSessionReconnectDelayMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

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
  private latestMessageIds = new Map<string, string>();
  private recentInboundEvents = new Map<string, true>();
  private replySequences = new Map<string, number>();
  private passiveReplyContexts = new Map<string, PassiveReplyContext>();
  private passiveReplyChains = new Map<string, PassiveReplyChain>();
  private groupAccumulators = new Map<string, GroupAccumulator>();
  private groupBufferGeneration = 0;

  constructor(config: QQBotConfig, name = 'qqbot', deps: QQBotChannelDeps = {}) {
    this.name = name;
    this.channelId = name;
    this.appId = config.appId?.trim() || '';
    this.clientSecret = config.clientSecret?.trim() || '';
    this.requireMention = config.requireMention !== false;
    this.groupContextLimit = normalizeGroupContextLimit(config.groupContextLimit);
    this.groupBatchWindowMs = normalizeGroupBatchWindowMs(config.groupBatchWindowMs);
    this.mediaConfig = config.media;
    this.fetchFn = deps.fetch || globalThis.fetch;
    this.saveInboundSessionFileFromPath = deps.saveInboundSessionFileFromPath;
    this.createWebSocket = deps.createWebSocket || ((url) => new WebSocket(url));
    this.reconnectDelaysMs = deps.reconnectDelaysMs || RECONNECT_DELAY_MS;
    this.invalidSessionReconnectDelayMs = deps.invalidSessionReconnectDelayMs ?? 3_000;
    this.now = deps.now || Date.now;
    this.setTimer = deps.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer || clearTimeout;
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
    this.groupBufferGeneration += 1;
    const generation = ++this.connectionGeneration;
    await this.connect(generation);
    logger.info({ channelId: this.channelId }, 'QQ Bot channel started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connectionGeneration += 1;
    this.groupBufferGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    this.latestMessageIds.clear();
    this.recentInboundEvents.clear();
    this.replySequences.clear();
    this.passiveReplyContexts.clear();
    this.passiveReplyChains.clear();
    this.clearAllGroupAccumulators();
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
    const persistedBoundReplyId = options?.qqbotChannelId === this.channelId
      && options?.qqbotConversationId === conversationId
      && typeof options.qqbotMessageId === 'string'
      && options.qqbotMessageId.trim()
      ? options.qqbotMessageId.trim()
      : undefined;
    const boundReplyId = persistedBoundReplyId
      ? this.latestMessageIds.get(conversationId) || persistedBoundReplyId
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
      let passiveReplyId = useProactiveFallback ? undefined : replyToId;
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
        const canRetryExpiredPassive = sourceBoundPassiveReply
          && !useProactiveFallback
          && Boolean(passiveReplyId)
          && (target.kind === 'c2c' || target.kind === 'group')
          && isQQBotMessageExpiredError(error);
        if (canRetryExpiredPassive) {
          if (!this.isCurrentReplyGeneration(replyGeneration)) {
            throw new Error('QQ Bot source-bound reply was invalidated before proactive retry');
          }
          this.markPassiveReplyExpired(replyToId!);
          passiveReplyId = undefined;
          try {
            await this.apiRequest(messagePath, 'POST', {
              content,
              msg_type: 0,
            });
          } catch (proactiveError) {
            if (options?.turnFinal) {
              logger.error({ err: proactiveError, channelId: this.channelId, conversationId, fallbackAttempted: true }, 'QQ Bot source-bound final reply could not be delivered');
              return;
            }
            throw proactiveError;
          }
        } else {
          if (sourceBoundPassiveReply && options?.turnFinal) {
            logger.error({ err: error, channelId: this.channelId, conversationId, fallbackAttempted: useProactiveFallback }, 'QQ Bot source-bound final reply could not be delivered');
            return;
          }
          throw error;
        }
      }
      if (sourceBoundPassiveReply && passiveReplyId && this.isCurrentReplyGeneration(replyGeneration)) {
        this.recordPassiveSuccessfulReply(passiveReplyId);
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

  async sendFile(conversationId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
    const target = parseQQBotConversationId(conversationId);
    if (target.kind !== 'c2c' && target.kind !== 'group') {
      throw new Error('QQ Bot media sending is unsupported for guild and DM destinations');
    }
    const mediaTarget: 'c2c' | 'group' = target.kind;

    const persistedReplyId = options?.qqbotChannelId === this.channelId
      && options?.qqbotConversationId === conversationId
      && typeof options.qqbotMessageId === 'string'
      && options.qqbotMessageId.trim()
      ? options.qqbotMessageId.trim()
      : undefined;
    const replyToId = this.latestMessageIds.get(conversationId) || persistedReplyId;
    const sourceBoundPassiveReply = Boolean(replyToId);
    const replyGeneration = this.connectionGeneration;
    const caption = normalizeQQBotCaption(options?.caption);
    const messagePath = target.kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(target.id)}/messages`
      : `/v2/groups/${encodeURIComponent(target.id)}/messages`;

    const send = async (): Promise<void> => {
      if (!this.isCurrentReplyGeneration(replyGeneration)) {
        throw new Error('QQ Bot media send was invalidated before upload');
      }
      const useProactiveFallback = sourceBoundPassiveReply && this.shouldUseProactiveReply(replyToId!);
      let passiveReplyId = useProactiveFallback ? undefined : replyToId;
      const uploaded = await uploadQQBotFile(
        mediaTarget,
        target.id,
        file,
        this.mediaConfig,
        {
          request: (requestPath, body, maxResponseBytes) => this.apiRequest(requestPath, 'POST', body, maxResponseBytes),
          fetch: this.fetchFn,
          isCurrent: () => this.isCurrentReplyGeneration(replyGeneration),
        },
      );
      if (!this.isCurrentReplyGeneration(replyGeneration)) {
        throw new Error('QQ Bot media send was invalidated before final delivery');
      }
      const messageSequence = passiveReplyId ? this.allocateReplySequence(passiveReplyId) : undefined;
      const messageBody = {
        ...(caption ? { content: caption } : {}),
        msg_type: 7,
        media: { file_info: uploaded.fileInfo },
        ...(passiveReplyId ? { msg_id: passiveReplyId, msg_seq: messageSequence } : { msg_seq: 1 }),
      };
      try {
        await this.apiRequest(messagePath, 'POST', messageBody);
      } catch (error) {
        const canRetryExpiredPassive = sourceBoundPassiveReply
          && !useProactiveFallback
          && Boolean(passiveReplyId)
          && isQQBotMessageExpiredError(error);
        if (!canRetryExpiredPassive) {
          throw error;
        }
        if (!this.isCurrentReplyGeneration(replyGeneration)) {
          throw new Error('QQ Bot source-bound media reply was invalidated before proactive retry');
        }
        this.markPassiveReplyExpired(replyToId!);
        passiveReplyId = undefined;
        await this.apiRequest(messagePath, 'POST', {
          ...(caption ? { content: caption } : {}),
          msg_type: 7,
          media: { file_info: uploaded.fileInfo },
          msg_seq: 1,
        });
      }
      if (sourceBoundPassiveReply && passiveReplyId && this.isCurrentReplyGeneration(replyGeneration)) {
        this.recordPassiveSuccessfulReply(passiveReplyId);
      }
      if (replyToId && options?.turnFinal && this.isCurrentReplyGeneration(replyGeneration)) {
        this.replySequences.delete(replyToId);
      }
    };

    if (!sourceBoundPassiveReply) {
      await send();
      return;
    }
    await this.enqueuePassiveReply(replyToId!, replyGeneration, send);
  }

  async sendTyping(conversationId: string): Promise<void> {
    const target = parseQQBotConversationId(conversationId);
    if (target.kind !== 'c2c') {
      return;
    }
    const messageId = this.latestMessageIds.get(conversationId);
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

    if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'].includes(frame.t)) {
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
    const inbound = this.normalizeInboundEvent(eventType, event);
    if (!inbound) {
      logger.warn({ channelId: this.channelId, eventType, messageId: event?.id }, 'Ignoring QQ Bot event without a stable identity');
      return;
    }

    const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
    const supportsInboundMedia = inbound.kind === 'c2c' || inbound.kind === 'group';
    if (!content.trim() && (!supportsInboundMedia || attachments.length === 0)) {
      logger.info({ channelId: this.channelId, eventType, messageId: event?.id }, 'Ignoring QQ Bot non-text message');
      return;
    }

    if (inbound.kind === 'group'
      && (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE')) {
      await this.routeGroupInboundMessage(eventType, inbound, content, attachments, event, sequence);
      return;
    }

    if (this.isDuplicateInboundEvent(eventType, inbound.messageId, event)) {
      logger.info({ channelId: this.channelId, eventType, messageId: inbound.messageId, sequence }, 'Ignoring duplicate QQ Bot inbound event');
      return;
    }
    await this.dispatchInboundMessage(eventType, inbound, content, attachments);
  }

  private async routeGroupInboundMessage(
    eventType: 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE',
    inbound: NormalizedInboundEvent,
    content: string,
    attachments: unknown[],
    event: any,
    sequence?: number,
  ): Promise<void> {
    const dedupKey = this.buildInboundEventKey(eventType, inbound.messageId, event);
    let accumulator = this.getGroupAccumulator(inbound.conversationId);
    if (accumulator) this.pruneGroupAccumulator(accumulator);
    const bufferedDuplicate = accumulator ? this.findBufferedGroupEvent(accumulator, dedupKey) : undefined;

    if (bufferedDuplicate && eventType !== 'GROUP_AT_MESSAGE_CREATE') {
      logger.info({ channelId: this.channelId, eventType, messageId: inbound.messageId, sequence }, 'Ignoring duplicate buffered QQ Bot group event');
      return;
    }
    if (bufferedDuplicate && accumulator) {
      this.removeBufferedGroupEvent(accumulator, dedupKey);
    }
    if (!bufferedDuplicate && this.recentInboundEvents.has(dedupKey)) {
      logger.info({ channelId: this.channelId, eventType, messageId: inbound.messageId, sequence }, 'Ignoring duplicate QQ Bot inbound event');
      return;
    }
    if (!bufferedDuplicate) {
      this.rememberInboundEventKey(dedupKey);
    }
    accumulator ||= this.getOrCreateGroupAccumulator(inbound.conversationId);

    const buffered: BufferedGroupEvent = {
      dedupKey,
      eventType,
      receivedAt: this.now(),
      inbound,
      content,
      attachments,
    };
    const isMention = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const isSlashCommand = content.trimStart().startsWith('/');

    if (isSlashCommand && (isMention || !this.requireMention)) {
      this.clearGroupAccumulator(inbound.conversationId);
      await this.dispatchInboundMessage(eventType, inbound, content, attachments);
      return;
    }

    if (this.requireMention) {
      if (!isMention) {
        this.appendGroupContext(accumulator, buffered);
        return;
      }
      const context = this.getDispatchContext(this.detachGroupAccumulator(inbound.conversationId)?.context || []);
      const platformHistory = context.length === 0
        ? extractPlatformGroupHistory(event?.msg_elements, content, this.groupContextLimit)
        : [];
      await this.dispatchGroupBatch(context, buffered, platformHistory);
      return;
    }

    if (accumulator.current) {
      this.appendGroupContext(accumulator, accumulator.current);
    }
    accumulator.current = buffered;
    if (accumulator.openedAt === undefined) {
      accumulator.openedAt = buffered.receivedAt;
    }

    if (isMention || attachments.length > 0 || this.groupBatchWindowMs === 0) {
      const detached = this.detachGroupAccumulator(inbound.conversationId);
      if (detached?.current) {
        await this.dispatchGroupBatch(this.getDispatchContext(detached.context), detached.current);
      }
      return;
    }
    this.scheduleGroupBatch(inbound.conversationId, accumulator);
  }

  private async dispatchInboundMessage(
    eventType: string,
    inbound: NormalizedInboundEvent,
    content: string,
    attachments: unknown[],
  ): Promise<void> {
    this.rememberPassiveReplyContext(inbound.messageId);
    this.rememberLatestMessageId(inbound.conversationId, inbound.messageId);
    const supportsInboundMedia = inbound.kind === 'c2c' || inbound.kind === 'group';

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
        await this.sendTyping(inbound.conversationId);
      },
    };
    const message: ChannelMessage = {
      parts: attachments.length > 0 && supportsInboundMedia
        ? buildQQBotAttachmentPreviewParts(content, attachments, this.mediaConfig)
        : [{ text: content }],
      ...(inbound.kind === 'group'
        ? { ingressMetadataParts: [buildQQBotGroupTriggerMetadata(eventType)!] }
        : {}),
      channelUserId: inbound.conversationId,
      conversationId: inbound.conversationId,
      username: inbound.username,
    };
    if (attachments.length > 0 && supportsInboundMedia) {
      message.materializeParts = (sessionId: string) => materializeQQBotAttachments({
        attachments,
        content,
        eventId: inbound.messageId,
        sessionId,
        config: this.mediaConfig,
        deps: {
          fetch: this.fetchFn,
          saveInboundSessionFileFromPath: this.saveInboundSessionFileFromPath,
        },
      });
    }

    try {
      await this.messageHandler?.(context, message);
    } catch (error) {
      logger.error({ err: error, channelId: this.channelId, eventType, messageId: inbound.messageId }, 'QQ Bot inbound handler failed');
    }
  }

  private async dispatchGroupBatch(
    contextEvents: BufferedGroupEvent[],
    current: BufferedGroupEvent,
    platformHistory: PlatformGroupHistoryItem[] = [],
  ): Promise<void> {
    const freshContext = contextEvents.filter(item => current.receivedAt - item.receivedAt <= GROUP_CONTEXT_TTL_MS);
    const content = this.buildGroupBatchContent(freshContext, current, platformHistory);
    await this.dispatchInboundMessage(current.eventType, current.inbound, content, current.attachments);
  }

  private buildGroupBatchContent(
    contextEvents: BufferedGroupEvent[],
    current: BufferedGroupEvent,
    platformHistory: PlatformGroupHistoryItem[] = [],
  ): string {
    if (contextEvents.length === 0 && platformHistory.length === 0) {
      return current.content;
    }
    const localItems = contextEvents.map((item) => {
      const attrs = formatFoxwarmAttributes({
        senderId: item.inbound.senderId,
        senderName: item.inbound.username,
        time: new Date(item.receivedAt).toISOString(),
      });
      const preview = buildQQBotAttachmentPreviewParts(item.content, item.attachments, this.mediaConfig)
        .map(part => part.text || '')
        .filter(Boolean)
        .join('\n');
      return `<foxwarm-qqbot-context-item ${attrs}>\n${escapeFoxwarmTextContent(preview)}\n</foxwarm-qqbot-context-item>`;
    });
    const platformItems = platformHistory.map(item => [
      '<foxwarm-qqbot-context-item source="platform-history">',
      escapeFoxwarmTextContent(item.content),
      '</foxwarm-qqbot-context-item>',
    ].join('\n'));
    const items = localItems.length > 0 ? localItems : platformItems;
    const contextBlock = [
      `<foxwarm-qqbot-context count="${items.length}" untrusted="true">`,
      ...items,
      '</foxwarm-qqbot-context>',
    ].join('\n');
    return current.content ? `${contextBlock}\n\n${current.content}` : contextBlock;
  }

  private normalizeInboundEvent(eventType: string, event: any): NormalizedInboundEvent | null {
    const messageId = typeof event?.id === 'string' ? event.id.trim() : '';
    if (!messageId) {
      return null;
    }
    if (eventType === 'C2C_MESSAGE_CREATE') {
      const senderId = typeof event?.author?.user_openid === 'string' ? event.author.user_openid.trim() : '';
      return senderId ? { kind: 'c2c', conversationId: `c2c:${senderId}`, senderId, username: senderId, messageId } : null;
    }
    if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE') {
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

  private getOrCreateGroupAccumulator(conversationId: string): GroupAccumulator {
    const existing = this.getGroupAccumulator(conversationId);
    if (existing) {
      return existing;
    }
    if (this.groupAccumulators.size >= MAX_GROUP_ACCUMULATORS) {
      const oldestConversationId = this.groupAccumulators.keys().next().value;
      if (oldestConversationId) this.clearGroupAccumulator(oldestConversationId);
    }
    const accumulator: GroupAccumulator = { context: [] };
    this.groupAccumulators.set(conversationId, accumulator);
    return accumulator;
  }

  private getGroupAccumulator(conversationId: string): GroupAccumulator | undefined {
    const accumulator = this.groupAccumulators.get(conversationId);
    if (!accumulator) return undefined;
    this.groupAccumulators.delete(conversationId);
    this.groupAccumulators.set(conversationId, accumulator);
    return accumulator;
  }

  private appendGroupContext(accumulator: GroupAccumulator, event: BufferedGroupEvent): void {
    accumulator.context.push(event);
    const retainedLimit = Math.max(1, this.groupContextLimit);
    if (accumulator.context.length > retainedLimit) {
      accumulator.context.splice(0, accumulator.context.length - retainedLimit);
    }
  }

  private getDispatchContext(context: BufferedGroupEvent[]): BufferedGroupEvent[] {
    return this.groupContextLimit === 0 ? [] : context.slice(-this.groupContextLimit);
  }

  private pruneGroupAccumulator(accumulator: GroupAccumulator): void {
    const cutoff = this.now() - GROUP_CONTEXT_TTL_MS;
    accumulator.context = accumulator.context.filter(item => item.receivedAt >= cutoff);
    if (accumulator.current && accumulator.current.receivedAt < cutoff) {
      accumulator.current = undefined;
      accumulator.openedAt = undefined;
      if (accumulator.timer) {
        this.clearTimer(accumulator.timer);
        accumulator.timer = undefined;
      }
    }
  }

  private findBufferedGroupEvent(accumulator: GroupAccumulator, dedupKey: string): BufferedGroupEvent | undefined {
    return accumulator.current?.dedupKey === dedupKey
      ? accumulator.current
      : accumulator.context.find(item => item.dedupKey === dedupKey);
  }

  private removeBufferedGroupEvent(accumulator: GroupAccumulator, dedupKey: string): BufferedGroupEvent | undefined {
    if (accumulator.current?.dedupKey === dedupKey) {
      const duplicate = accumulator.current;
      accumulator.current = undefined;
      return duplicate;
    }
    const index = accumulator.context.findIndex(item => item.dedupKey === dedupKey);
    if (index === -1) return undefined;
    return accumulator.context.splice(index, 1)[0];
  }

  private scheduleGroupBatch(conversationId: string, accumulator: GroupAccumulator): void {
    if (accumulator.timer || this.groupBatchWindowMs === 0) return;
    const generation = this.groupBufferGeneration;
    const elapsed = Math.max(0, this.now() - (accumulator.openedAt ?? this.now()));
    const delayMs = Math.max(0, this.groupBatchWindowMs - elapsed);
    const timer = this.setTimer(() => {
      if (generation !== this.groupBufferGeneration
        || this.groupAccumulators.get(conversationId) !== accumulator
        || accumulator.timer !== timer) {
        return;
      }
      accumulator.timer = undefined;
      const detached = this.detachGroupAccumulator(conversationId);
      if (detached?.current) {
        void this.dispatchGroupBatch(this.getDispatchContext(detached.context), detached.current);
      }
    }, delayMs);
    timer.unref?.();
    accumulator.timer = timer;
  }

  private detachGroupAccumulator(conversationId: string): GroupAccumulator | undefined {
    const accumulator = this.groupAccumulators.get(conversationId);
    if (!accumulator) return undefined;
    this.groupAccumulators.delete(conversationId);
    if (accumulator.timer) {
      this.clearTimer(accumulator.timer);
      accumulator.timer = undefined;
    }
    return accumulator;
  }

  private clearGroupAccumulator(conversationId: string): void {
    this.detachGroupAccumulator(conversationId);
  }

  private clearAllGroupAccumulators(): void {
    for (const accumulator of this.groupAccumulators.values()) {
      if (accumulator.timer) this.clearTimer(accumulator.timer);
    }
    this.groupAccumulators.clear();
  }

  private buildInboundEventKey(eventType: string, messageId: string, event: any): string {
    const messageSequence = normalizeBusinessScalar(event?.msg_seq);
    const messageIndex = getMessageSceneIndex(event?.message_scene?.ext);
    const canonicalEventType = eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE'
      ? 'GROUP_MESSAGE_CREATE'
      : eventType;
    return `${canonicalEventType}:${messageId}:${messageSequence ? `seq=${messageSequence}` : 'seq=-'}:${messageIndex ? `idx=${messageIndex}` : 'idx=-'}`;
  }

  private rememberInboundEventKey(key: string): void {
    if (this.recentInboundEvents.size >= MAX_RECENT_INBOUND_EVENTS) {
      const oldest = this.recentInboundEvents.keys().next().value;
      if (oldest) this.recentInboundEvents.delete(oldest);
    }
    this.recentInboundEvents.set(key, true);
  }

  private isDuplicateInboundEvent(eventType: string, messageId: string, event: any): boolean {
    const key = this.buildInboundEventKey(eventType, messageId, event);
    if (this.recentInboundEvents.has(key)) {
      return true;
    }
    this.rememberInboundEventKey(key);
    return false;
  }

  private rememberLatestMessageId(conversationId: string, messageId: string): void {
    if (!this.latestMessageIds.has(conversationId) && this.latestMessageIds.size >= MAX_LATEST_MESSAGE_CONTEXTS) {
      const oldestConversationId = this.latestMessageIds.keys().next().value;
      if (oldestConversationId) {
        this.latestMessageIds.delete(oldestConversationId);
      }
    }
    this.latestMessageIds.set(conversationId, messageId);
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
    if (this.passiveReplyContexts.size >= MAX_PASSIVE_REPLY_CONTEXTS) {
      const oldest = this.passiveReplyContexts.keys().next().value;
      if (oldest) {
        this.passiveReplyContexts.delete(oldest);
      }
    }
    const context = { firstSeenAt: now, successfulReplies: 0, expired: false };
    this.passiveReplyContexts.set(messageId, context);
    return context;
  }

  private shouldUseProactiveReply(messageId: string): boolean {
    const context = this.rememberPassiveReplyContext(messageId);
    return context.expired === true
      || Date.now() - context.firstSeenAt >= PASSIVE_REPLY_TTL_MS
      || context.successfulReplies >= MAX_PASSIVE_TEXT_REPLIES;
  }

  private markPassiveReplyExpired(messageId: string): void {
    const context = this.rememberPassiveReplyContext(messageId);
    context.expired = true;
  }

  private recordPassiveSuccessfulReply(messageId: string): void {
    const context = this.rememberPassiveReplyContext(messageId);
    context.successfulReplies += 1;
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

  private async apiRequest<T = any>(path: string, method: 'GET' | 'POST', body?: Record<string, any>, maxResponseBytes?: number): Promise<T> {
    return this.requestWithToken<T>(path, method, body, false, maxResponseBytes);
  }

  private async requestWithToken<T>(path: string, method: 'GET' | 'POST', body: Record<string, any> | undefined, retried: boolean, maxResponseBytes?: number): Promise<T> {
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
      return this.requestWithToken(path, method, body, true, maxResponseBytes);
    }
    const responseText = maxResponseBytes === undefined
      ? await response.text()
      : await readResponseTextBounded(response, maxResponseBytes);
    if (!response.ok) {
      throw new QQBotApiError(
        `QQ Bot API ${method} ${path} failed (${response.status}): ${responseText.slice(0, 300)}`,
        parseQQBotApiErrorCode(responseText),
      );
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
