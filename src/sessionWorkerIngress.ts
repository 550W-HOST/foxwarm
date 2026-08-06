import crypto from 'node:crypto';
import type { ChannelContext } from './channel';
import { RpcError } from './rpc';
import { normalizeSessionTurnDeliverySource } from './sessionTurnDelivery';
import type { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { stableSessionWorkerJson } from './sessionWorkerStableJson';
import type { ImageMeta, InlineDataRef, Message, MessagePart, QueueItem } from './types';
import { isSystemPayloadTextPart } from './utils/systemMessageParts';

const MAX_INGRESS_BYTES = 1024 * 1024;
const ITEM_KEYS = ['type', 'source', 'sourceSessionId', 'clientMessageId', 'parts', 'message', 'waitTimeoutId'];
const PART_KEYS = ['text', 'system', 'systemPayload', 'inlineDataRef', 'imageMeta'];
const SOURCE_KEYS = ['platform', 'channelId', 'channelType', 'channelUserId', 'conversationId', 'username', 'senderId', 'weworkStreamId', 'qqbotMessageId', 'preferDirectReply'];

function invalid(message: string): never { throw new RpcError('SESSION_WORKER_INGRESS_INVALID', message); }
function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid(`${label} must contain only enumerable string data fields.`);
  }
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) invalid(`${label} contains unsupported field: ${extra}.`);
}
function stringValue(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > max) invalid(`${label} must be a non-empty bounded string.`);
  return value;
}
function integer(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid(`${label} must be a bounded integer.`);
  return value as number;
}
function values(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || !value.length) invalid(`${label} must be a non-empty array.`);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(`${label} must contain only dense indexed data values.`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid(`${label} must contain only dense indexed data values.`);
  }
  return value;
}
function optionalText(object: Record<string, unknown>, key: string, label: string, max = 512): string | undefined {
  return Object.prototype.hasOwnProperty.call(object, key) ? stringValue(object[key], `${label}.${key}`, max) : undefined;
}
function normalizeIngressSource(value: unknown) {
  plain(value, 'item.source'); exact(value, SOURCE_KEYS, 'item.source');
  try { return normalizeSessionTurnDeliverySource(value); }
  catch (error: any) { invalid(error?.message || 'item.source is invalid.'); }
}
function normalizeInlineDataRef(value: unknown, label: string): InlineDataRef {
  plain(value, label); exact(value, ['imageId', 'blobId', 'apiPath', 'format', 'path', 'mimeType', 'byteLength', 'sha256', 'width', 'height'], label);
  const result: InlineDataRef = {
    imageId: stringValue(value.imageId, `${label}.imageId`), mimeType: stringValue(value.mimeType, `${label}.mimeType`, 128),
    byteLength: integer(value.byteLength, `${label}.byteLength`), sha256: stringValue(value.sha256, `${label}.sha256`, 128),
  };
  if (!/^[a-fA-F0-9]{64}$/.test(result.sha256)) invalid(`${label}.sha256 must be a SHA-256 hex digest.`);
  for (const key of ['blobId', 'apiPath', 'format', 'path'] as const) { const text = optionalText(value, key, label, 2048); if (text) result[key] = text; }
  for (const key of ['width', 'height'] as const) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = integer(value[key], `${label}.${key}`, 1);
  return result;
}
function normalizeImageMeta(value: unknown, label: string): ImageMeta {
  plain(value, label); exact(value, ['imageId', 'mimeType', 'width', 'height', 'sizeBytes', 'sha256'], label);
  const result: ImageMeta = { imageId: stringValue(value.imageId, `${label}.imageId`) };
  const mimeType = optionalText(value, 'mimeType', label, 128); if (mimeType) result.mimeType = mimeType;
  const sha256 = optionalText(value, 'sha256', label, 128);
  if (sha256) { if (!/^[a-fA-F0-9]{64}$/.test(sha256)) invalid(`${label}.sha256 must be a SHA-256 hex digest.`); result.sha256 = sha256; }
  for (const key of ['width', 'height', 'sizeBytes'] as const) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = integer(value[key], `${label}.${key}`, key === 'sizeBytes' ? 0 : 1);
  return result;
}
function normalizePart(value: unknown, index: number): MessagePart {
  const label = `item part ${index}`; plain(value, label); exact(value, PART_KEYS, label);
  const result: MessagePart = {};
  if (Object.prototype.hasOwnProperty.call(value, 'text')) { if (typeof value.text !== 'string') invalid(`${label}.text must be a string.`); result.text = value.text; }
  if (Object.prototype.hasOwnProperty.call(value, 'system')) { if (typeof value.system !== 'string') invalid(`${label}.system must be a string.`); result.system = value.system; }
  if (Object.prototype.hasOwnProperty.call(value, 'systemPayload')) { if (typeof value.systemPayload !== 'boolean') invalid(`${label}.systemPayload must be boolean.`); result.systemPayload = value.systemPayload; }
  if (Object.prototype.hasOwnProperty.call(value, 'inlineDataRef')) result.inlineDataRef = normalizeInlineDataRef(value.inlineDataRef, `${label}.inlineDataRef`);
  if (Object.prototype.hasOwnProperty.call(value, 'imageMeta')) result.imageMeta = normalizeImageMeta(value.imageMeta, `${label}.imageMeta`);
  if (result.systemPayload === true && !isSystemPayloadTextPart(result)) invalid(`${label}.systemPayload:true requires text.`);
  if (!result.text?.length && !result.system?.length && !result.inlineDataRef) invalid(`${label} must contain text, system text, or an image reference.`);
  return result;
}
function normalizeParts(value: unknown, label: string): MessagePart[] { return values(value, label).map((part, index) => normalizePart(part, index)); }
function normalizeMessage(value: unknown): Message {
  plain(value, 'item.message'); exact(value, ['role', 'parts', 'modelVisible', '__meta'], 'item.message');
  if (!['user', 'model', 'tool'].includes(value.role as string)) invalid('item.message.role is invalid.');
  const result: Message = { role: value.role as Message['role'], parts: normalizeParts(value.parts, 'item.message.parts') };
  if (Object.prototype.hasOwnProperty.call(value, 'modelVisible')) { if (typeof value.modelVisible !== 'boolean') invalid('item.message.modelVisible must be boolean.'); result.modelVisible = value.modelVisible; }
  if (Object.prototype.hasOwnProperty.call(value, '__meta')) {
    plain(value.__meta, 'item.message.__meta'); exact(value.__meta, ['timestamp', 'seq'], 'item.message.__meta');
    result.__meta = {};
    for (const key of ['timestamp', 'seq'] as const) if (Object.prototype.hasOwnProperty.call(value.__meta, key)) result.__meta[key] = integer(value.__meta[key], `item.message.__meta.${key}`);
  }
  return result;
}

export function normalizeSessionWorkerIngressRequest(value: unknown): { sessionId: string; item: QueueItem } {
  plain(value, 'submitAndRun request'); exact(value, ['sessionId', 'item'], 'submitAndRun request');
  const sessionId = stringValue(value.sessionId, 'sessionId', 256);
  if (sessionId !== sessionId.trim()) invalid('sessionId must be an exact canonical ID without surrounding whitespace.');
  plain(value.item, 'item'); exact(value.item, ITEM_KEYS, 'item');
  const type = value.item.type;
  if (type === 'compact-commit') throw new RpcError('SESSION_WORKER_QUEUE_UNSUPPORTED', 'Managed-session and compact-commit queues are not supported by the Session worker yet.', true);
  if (!['user', 'intersession', 'background', 'trigger', 'onboot'].includes(type as string)) invalid('item.type is not an ordinary supported queue type.');
  const hasParts = Object.prototype.hasOwnProperty.call(value.item, 'parts');
  const hasMessage = Object.prototype.hasOwnProperty.call(value.item, 'message');
  if (hasParts === hasMessage) invalid('item must contain exactly one of parts or message.');
  const item: QueueItem = { type: type as QueueItem['type'] };
  if (hasParts) item.parts = normalizeParts(value.item.parts, 'item.parts'); else item.message = normalizeMessage(value.item.message);
  if (Object.prototype.hasOwnProperty.call(value.item, 'source')) item.source = normalizeIngressSource(value.item.source);
  const stringFields = [['sourceSessionId', 256], ['clientMessageId', 512], ['waitTimeoutId', 256]] as const;
  for (const [key, max] of stringFields) if (Object.prototype.hasOwnProperty.call(value.item, key)) item[key] = stringValue(value.item[key], `item.${key}`, max);
  if (item.source && type !== 'user') invalid('item.source is supported only for user input.');
  if (item.clientMessageId && type !== 'user') invalid('item.clientMessageId is supported only for user input.');
  if (item.sourceSessionId && type !== 'intersession') invalid('item.sourceSessionId is supported only for intersession input.');
  if (item.waitTimeoutId && type !== 'background') invalid('item.waitTimeoutId is supported only for background input.');
  const bytes = Buffer.byteLength(stableSessionWorkerJson(item), 'utf8');
  if (bytes > MAX_INGRESS_BYTES) throw new RpcError('SESSION_WORKER_INGRESS_TOO_LARGE', `QueueItem exceeds the ${MAX_INGRESS_BYTES}-byte ingress bound.`);
  return { sessionId, item };
}

export type SessionWorkerIngressResult = {
  accepted: true;
  mailboxIntentId: number;
  generation: number;
  lastAppliedMailboxId: number;
  messageCount: number;
  busy: boolean;
};

export class SessionWorkerIngressCoordinator {
  constructor(
    private readonly store: SessionWorkerStore,
    private readonly supervisor: SessionWorkerSupervisor,
    readonly sourceContexts: SessionWorkerSourceContextRegistry,
    private readonly resolveCanonicalSessionId: (sessionId: string) => string,
  ) {}

  registerSourceContext(sessionId: string, item: QueueItem, context?: ChannelContext): () => void {
    if (!context || !item.source) return () => {};
    return this.sourceContexts.register(sessionId, normalizeIngressSource(item.source), context);
  }

  async submitQueuedInput(requestedSessionId: string, item: QueueItem): Promise<SessionWorkerIngressResult> {
    const normalized = normalizeSessionWorkerIngressRequest({ sessionId: requestedSessionId, item });
    requestedSessionId = normalized.sessionId; item = normalized.item;
    const sessionId = this.resolveCanonicalSessionId(requestedSessionId);
    if (sessionId !== requestedSessionId) {
      throw new RpcError('SESSION_WORKER_INGRESS_INVALID_SESSION', 'submitAndRun does not accept a session alias.');
    }
    const payload = item;
    const ownership = this.store.findOwnership(sessionId);
    if (!ownership || ownership.state !== 'ready' || !ownership.incarnationId) {
      throw new RpcError('SESSION_WORKER_INGRESS_UNAVAILABLE', `Session worker ${sessionId} has no activated durable owner.`, true);
    }
    const expected = { generation: ownership.generation, incarnationId: ownership.incarnationId };
    this.supervisor.assertActivatedOwnership(sessionId, expected);
    const intent = this.store.enqueueIntent(sessionId, crypto.randomUUID(), 'enqueue', payload);
    const projection = await this.supervisor.runPendingActivated(sessionId, expected);
    if (projection.lastAppliedMailboxId < intent.id) {
      throw new RpcError('SESSION_WORKER_INGRESS_AMBIGUOUS', `Session worker ${sessionId} did not confirm the durable mailbox intent.`, true);
    }
    return {
      accepted: true,
      mailboxIntentId: intent.id,
      generation: expected.generation,
      lastAppliedMailboxId: projection.lastAppliedMailboxId,
      messageCount: projection.messageCount,
      busy: projection.busy,
    };
  }
}
