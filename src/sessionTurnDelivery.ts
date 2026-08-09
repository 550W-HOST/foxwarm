import { logger } from './common';
import { getChannelId, getChannelType, getConversationId, type ChannelContext } from './channel';
import { deliverCommittedFinalToAttachments } from './session/channels';
import { defineRpcService, rpcMethod, RpcClient, RpcError, type RpcServiceHandler, type RpcTransport } from './rpc';
import type { QueueSource } from './types';
export type SessionTurnFinalKind = 'response' | 'error' | 'empty-final';
export type SessionTurnDeliveryRequest = { sourceSessionId: string; source: QueueSource; outcome: SessionTurnFinalKind; text: string };
export type SessionTurnIntermediateDeliveryRequest = { sourceSessionId: string; source: QueueSource; text: string };
export type SessionTurnDeliveryAck = { attempted: number; delivered: number };
export type ExactFinalSourceContextResolver = (sourceSessionId: string, source: QueueSource) => ChannelContext | undefined | Promise<ChannelContext | undefined>;
export const sessionTurnDeliveryServiceDescriptor = defineRpcService('session-turn-delivery', 2, {
  deliverCommittedFinal: rpcMethod<SessionTurnDeliveryRequest, SessionTurnDeliveryAck>(),
  deliverIntermediateText: rpcMethod<SessionTurnIntermediateDeliveryRequest, SessionTurnDeliveryAck>(),
});
function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RpcError('SESSION_TURN_DELIVERY_INVALID', `${label} must be a plain object.`);
  }
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new RpcError('SESSION_TURN_DELIVERY_INVALID', `${label} contains unsupported field: ${extra}.`);
}
function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || Buffer.byteLength(value, 'utf8') > max) {
    throw new RpcError('SESSION_TURN_DELIVERY_INVALID', `${label} is invalid or exceeds its bound.`);
  }
  return value;
}
const SOURCE_KEYS = ['platform', 'channelId', 'channelType', 'channelUserId', 'conversationId', 'username', 'senderId', 'weworkStreamId', 'qqbotMessageId', 'preferDirectReply'] as const;
export function normalizeSessionTurnDeliverySource(value: unknown): QueueSource {
  plain(value, 'source');
  exactKeys(value, [...SOURCE_KEYS], 'source');
  const result: any = {
    platform: text(value.platform, 'source.platform', 128),
    channelUserId: text(value.channelUserId, 'source.channelUserId', 512),
  };
  for (const key of SOURCE_KEYS.slice(1, -1)) {
    if (value[key] !== undefined) result[key] = text(value[key], `source.${key}`, 512);
  }
  if (value.preferDirectReply !== undefined) {
    if (value.preferDirectReply !== true) throw new RpcError('SESSION_TURN_DELIVERY_INVALID', 'source.preferDirectReply must be true when present.');
    result.preferDirectReply = true;
  }
  return result;
}
function sourceFromContext(ctx: ChannelContext): QueueSource {
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
const sameSource = (left: QueueSource, right: QueueSource) => SOURCE_KEYS.every(key => left[key] === right[key]);
function finalOptions(source: QueueSource, outcome: SessionTurnFinalKind): any {
  const stream = source.weworkStreamId ? {
    weworkStreamId: source.weworkStreamId,
    weworkStreamChannelId: source.channelId || source.platform,
    weworkStreamConversationId: source.conversationId || source.channelUserId,
  } : {};
  const qqbot = source.qqbotMessageId ? {
    qqbotMessageId: source.qqbotMessageId,
    qqbotChannelId: source.channelId || source.platform,
    qqbotConversationId: source.conversationId || source.channelUserId,
  } : {};
  if (outcome === 'empty-final') return {
    ...stream, turnFinal: true, allowEmptyBroadcast: true,
    targetChannel: { channelId: source.channelId || source.platform, conversationId: source.conversationId || source.channelUserId },
  };
  return { ...stream, ...qqbot, ...(outcome === 'response' ? { excludePlatforms: ['webui'] } : {}), turnFinal: true };
}
function intermediateOptions(source: QueueSource): any {
  const stream = source.weworkStreamId ? {
    weworkStreamId: source.weworkStreamId,
    weworkStreamChannelId: source.channelId || source.platform,
    weworkStreamConversationId: source.conversationId || source.channelUserId,
  } : {};
  const qqbot = source.qqbotMessageId ? {
    qqbotMessageId: source.qqbotMessageId,
    qqbotChannelId: source.channelId || source.platform,
    qqbotConversationId: source.conversationId || source.channelUserId,
  } : {};
  return {
    ...stream,
    ...qqbot,
    parse_mode: 'Markdown',
    excludePlatforms: ['webui', ...(source.weworkStreamId ? [source.channelId || source.platform] : [])],
  };
}
async function deliverAttachments(sourceSessionId: string, textValue: string, options: any): Promise<SessionTurnDeliveryAck> {
  try {
    const result = await deliverCommittedFinalToAttachments(sourceSessionId, textValue, options);
    for (const failure of result.failures) logger.error({ sessionId: sourceSessionId, failure }, 'Session turn attachment delivery failed');
    return { attempted: result.attempted, delivered: result.delivered };
  } catch (error: any) {
    logger.error({ err: error, sessionId: sourceSessionId }, 'Session turn attachment delivery failed');
    return { attempted: 0, delivered: 0 };
  }
}
export function createSessionTurnDeliveryServiceHandler(options: {
  expectedSourceSessionId: string;
  resolveExactSourceContext?: ExactFinalSourceContextResolver;
}): RpcServiceHandler<typeof sessionTurnDeliveryServiceDescriptor> {
  return {
    async deliverCommittedFinal(input) {
      plain(input, 'request'); exactKeys(input, ['sourceSessionId', 'source', 'outcome', 'text'], 'request');
      const sourceSessionId = text(input.sourceSessionId, 'sourceSessionId', 256);
      if (sourceSessionId !== options.expectedSourceSessionId) throw new RpcError('SESSION_TURN_DELIVERY_SOURCE_MISMATCH', 'Committed-final source session mismatch.');
      if (!['response', 'error', 'empty-final'].includes(input.outcome)) throw new RpcError('SESSION_TURN_DELIVERY_INVALID', 'outcome is invalid.');
      const outcome = input.outcome as SessionTurnFinalKind;
      const finalText = text(input.text, 'text', 1024 * 1024, outcome === 'empty-final');
      if (outcome === 'empty-final' && finalText !== '') throw new RpcError('SESSION_TURN_DELIVERY_INVALID', 'empty-final text must be empty.');
      const source = normalizeSessionTurnDeliverySource(input.source);
      const deliveryOptions = finalOptions(source, outcome);
      if (source.preferDirectReply && options.resolveExactSourceContext) {
        let ctx: ChannelContext | undefined;
        try { ctx = await options.resolveExactSourceContext(sourceSessionId, structuredClone(source)); }
        catch (error) { logger.warn({ err: error, sessionId: sourceSessionId }, 'Exact committed-final source lookup failed; using attachments'); }
        if (ctx && sameSource(sourceFromContext(ctx), source)) {
          try { await ctx.reply(finalText, deliveryOptions); return { attempted: 1, delivered: 1 }; }
          catch (error: any) {
            logger.error({ err: error, sessionId: sourceSessionId, outcome }, 'Committed final direct delivery failed');
            return { attempted: 1, delivered: 0 };
          }
        }
      }
      return deliverAttachments(sourceSessionId, finalText, deliveryOptions);
    },
    async deliverIntermediateText(input) {
      plain(input, 'request'); exactKeys(input, ['sourceSessionId', 'source', 'text'], 'request');
      const sourceSessionId = text(input.sourceSessionId, 'sourceSessionId', 256);
      if (sourceSessionId !== options.expectedSourceSessionId) throw new RpcError('SESSION_TURN_DELIVERY_SOURCE_MISMATCH', 'Intermediate delivery source session mismatch.');
      const source = normalizeSessionTurnDeliverySource(input.source);
      const intermediateText = text(input.text, 'text', 1024 * 1024);
      return deliverAttachments(sourceSessionId, intermediateText, intermediateOptions(source));
    },
  };
}
let transport: RpcTransport | undefined;
let client: RpcClient<typeof sessionTurnDeliveryServiceDescriptor> | undefined;
export async function initializeSessionTurnDelivery(reverseTransport: RpcTransport) {
  if (client) {
    if (transport !== reverseTransport) throw new RpcError('SESSION_TURN_DELIVERY_PLACEMENT_LOCKED', 'Committed-final delivery placement is already initialized.');
    return;
  }
  transport = reverseTransport; client = new RpcClient(sessionTurnDeliveryServiceDescriptor, reverseTransport);
}
export async function deliverCommittedFinal(request: SessionTurnDeliveryRequest): Promise<SessionTurnDeliveryAck> {
  if (!client) throw new RpcError('SESSION_TURN_DELIVERY_UNAVAILABLE', 'Committed-final delivery is unavailable.', true);
  return client.call('deliverCommittedFinal', request);
}
export async function deliverIntermediateText(request: SessionTurnIntermediateDeliveryRequest): Promise<SessionTurnDeliveryAck> {
  if (!client) throw new RpcError('SESSION_TURN_DELIVERY_UNAVAILABLE', 'Intermediate delivery is unavailable.', true);
  return client.call('deliverIntermediateText', request);
}
export async function shutdownSessionTurnDelivery() { client = undefined; transport = undefined; }
