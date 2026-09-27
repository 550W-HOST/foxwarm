import { logger } from './common';
import { getChannelId, getChannelType, getConversationId, type ChannelContext } from './channel';
import { deliverCommittedFinalToAttachments, finishChannelTurnProgress, reportChannelTurnProgress } from './session/channels';
import { defineRpcService, rpcMethod, RpcClient, RpcError, type RpcServiceHandler, type RpcTransport } from './rpc';
import type { ChannelTurnProgress, QueueSource } from './types';

export type SessionTurnFinalKind = 'response' | 'error' | 'empty-final';
export type SessionTurnDeliveryRequest = { sourceSessionId: string; turnId?: string; outcome: SessionTurnFinalKind; text: string };
export type SessionTurnIntermediateDeliveryRequest = { sourceSessionId: string; turnId?: string; text: string };
export type SessionTurnProgressRequest = { sourceSessionId: string; turnId: string; progress: ChannelTurnProgress };
export type SessionTurnProgressFinishRequest = { sourceSessionId: string; turnId: string };
export type SessionTurnDeliveryAck = { attempted: number; delivered: number };

export const sessionTurnDeliveryServiceDescriptor = defineRpcService('session-turn-delivery', 3, {
  deliverCommittedFinal: rpcMethod<SessionTurnDeliveryRequest, SessionTurnDeliveryAck>(),
  deliverIntermediateText: rpcMethod<SessionTurnIntermediateDeliveryRequest, SessionTurnDeliveryAck>(),
  reportProgress: rpcMethod<SessionTurnProgressRequest, void>(),
  finishProgress: rpcMethod<SessionTurnProgressFinishRequest, void>(),
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

const CURRENT_SOURCE_KEYS = ['platform', 'channelId', 'channelType', 'channelUserId', 'conversationId', 'username', 'senderId'] as const;
const LEGACY_SOURCE_KEYS = [...CURRENT_SOURCE_KEYS, 'weworkStreamId', 'qqbotMessageId', 'preferDirectReply'] as const;

/** Read-old/write-new QueueSource normalization for persisted Session data and Worker ingress. */
export function normalizeSessionTurnDeliverySource(value: unknown): QueueSource {
  plain(value, 'source');
  exactKeys(value, [...LEGACY_SOURCE_KEYS], 'source');
  const result: QueueSource = {
    platform: text(value.platform, 'source.platform', 128),
    channelUserId: text(value.channelUserId, 'source.channelUserId', 512),
  };
  for (const key of CURRENT_SOURCE_KEYS.slice(1)) {
    if (value[key] !== undefined) (result as any)[key] = text(value[key], `source.${key}`, 512);
  }
  for (const key of ['weworkStreamId', 'qqbotMessageId'] as const) {
    if (value[key] !== undefined) text(value[key], `legacy source.${key}`, 512);
  }
  if (value.preferDirectReply !== undefined && typeof value.preferDirectReply !== 'boolean') {
    throw new RpcError('SESSION_TURN_DELIVERY_INVALID', 'legacy source.preferDirectReply must be boolean when present.');
  }
  return result;
}

export function snapshotQueueSource(ctx: ChannelContext): QueueSource {
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

function finalOptions(outcome: SessionTurnFinalKind, turnId?: string): any {
  return {
    ...(outcome === 'response' ? { excludePlatforms: ['webui'] } : {}),
    ...(outcome === 'empty-final' ? { allowEmptyBroadcast: true } : {}),
    ...(turnId ? { channelProgressTurnId: turnId } : {}),
    turnFinal: true,
  };
}

function intermediateOptions(turnId?: string): any {
  return {
    parse_mode: 'Markdown',
    excludePlatforms: ['webui'],
    ...(turnId ? { channelProgressTurnId: turnId } : {}),
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
}): RpcServiceHandler<typeof sessionTurnDeliveryServiceDescriptor> {
  return {
    async deliverCommittedFinal(input) {
      plain(input, 'request'); exactKeys(input, ['sourceSessionId', 'turnId', 'outcome', 'text'], 'request');
      const sourceSessionId = text(input.sourceSessionId, 'sourceSessionId', 256);
      if (sourceSessionId !== options.expectedSourceSessionId) throw new RpcError('SESSION_TURN_DELIVERY_SOURCE_MISMATCH', 'Committed-final source session mismatch.');
      if (!['response', 'error', 'empty-final'].includes(input.outcome)) throw new RpcError('SESSION_TURN_DELIVERY_INVALID', 'outcome is invalid.');
      const outcome = input.outcome as SessionTurnFinalKind;
      const finalText = text(input.text, 'text', 1024 * 1024, outcome === 'empty-final');
      if (outcome === 'empty-final' && finalText !== '') throw new RpcError('SESSION_TURN_DELIVERY_INVALID', 'empty-final text must be empty.');
      const turnId = input.turnId === undefined ? undefined : text(input.turnId, 'turnId', 128);
      return deliverAttachments(sourceSessionId, finalText, finalOptions(outcome, turnId));
    },
    async deliverIntermediateText(input) {
      plain(input, 'request'); exactKeys(input, ['sourceSessionId', 'turnId', 'text'], 'request');
      const sourceSessionId = text(input.sourceSessionId, 'sourceSessionId', 256);
      if (sourceSessionId !== options.expectedSourceSessionId) throw new RpcError('SESSION_TURN_DELIVERY_SOURCE_MISMATCH', 'Intermediate delivery source session mismatch.');
      const turnId = input.turnId === undefined ? undefined : text(input.turnId, 'turnId', 128);
      return deliverAttachments(sourceSessionId, text(input.text, 'text', 1024 * 1024), intermediateOptions(turnId));
    },
    async reportProgress(input) {
      plain(input, 'request'); exactKeys(input, ['sourceSessionId', 'turnId', 'progress'], 'request');
      const sourceSessionId = text(input.sourceSessionId, 'sourceSessionId', 256);
      if (sourceSessionId !== options.expectedSourceSessionId) throw new RpcError('SESSION_TURN_DELIVERY_SOURCE_MISMATCH', 'Progress source session mismatch.');
      const turnId = text(input.turnId, 'turnId', 128);
      plain(input.progress, 'progress');
      reportChannelTurnProgress(sourceSessionId, turnId, input.progress as ChannelTurnProgress);
    },
    async finishProgress(input) {
      plain(input, 'request'); exactKeys(input, ['sourceSessionId', 'turnId'], 'request');
      const sourceSessionId = text(input.sourceSessionId, 'sourceSessionId', 256);
      if (sourceSessionId !== options.expectedSourceSessionId) throw new RpcError('SESSION_TURN_DELIVERY_SOURCE_MISMATCH', 'Progress source session mismatch.');
      await finishChannelTurnProgress(text(input.turnId, 'turnId', 128));
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
  transport = reverseTransport;
  client = new RpcClient(sessionTurnDeliveryServiceDescriptor, reverseTransport);
}

export async function deliverCommittedFinal(request: SessionTurnDeliveryRequest): Promise<SessionTurnDeliveryAck> {
  if (!client) throw new RpcError('SESSION_TURN_DELIVERY_UNAVAILABLE', 'Committed-final delivery is unavailable.', true);
  return client.call('deliverCommittedFinal', request);
}

export async function deliverIntermediateText(request: SessionTurnIntermediateDeliveryRequest): Promise<SessionTurnDeliveryAck> {
  if (!client) throw new RpcError('SESSION_TURN_DELIVERY_UNAVAILABLE', 'Intermediate delivery is unavailable.', true);
  return client.call('deliverIntermediateText', request);
}

export async function reportChannelProgress(request: SessionTurnProgressRequest): Promise<void> {
  if (!client) throw new RpcError('SESSION_TURN_DELIVERY_UNAVAILABLE', 'Progress delivery is unavailable.', true);
  await client.call('reportProgress', request);
}

export async function finishChannelProgress(request: SessionTurnProgressFinishRequest): Promise<void> {
  if (!client) throw new RpcError('SESSION_TURN_DELIVERY_UNAVAILABLE', 'Progress delivery is unavailable.', true);
  await client.call('finishProgress', request);
}

export async function shutdownSessionTurnDelivery() {
  client = undefined;
  transport = undefined;
}
